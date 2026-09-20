//! Terrain line-of-sight over baked height rasters (decision-AI groundwork).
//!
//! Loads the `terrain_los.npz` rasters baked by
//! `scripts/experiments/bake_terrain_los.py` (experiment E4) and answers
//! point-to-point LOS queries over them. An npz is a plain zip container of
//! `.npy` arrays, so reading it needs only the `zip` crate already linked for
//! the Mod Hub — no new dependency. Only the `height` (f32, res×res) and
//! `bounds` (f64×4: minX maxX minZ maxZ) arrays are consumed; the per-observer
//! visibility masks stored alongside are raster-space approximations that the
//! exact ray march here replaces.
//!
//! Raster orientation matches the baker: row 0 = minZ (south), column 0 =
//! minX (west), row-major C order; each cell holds the MAX terrain height
//! binned into it (underwater terrain clamped to sea level 0).
//!
//! LOS semantics mirror the E4 Python `rays_blocked`:
//!   - the ray is parametrised by t ∈ [0, 1] between the two world points
//!     (the Python version, having only cell indices, starts at the observer
//!     CELL CENTRE; with true world coordinates available here the ray starts
//!     at the actual point — the one intentional divergence, noted because
//!     everything else is kept byte-comparable in spirit);
//!   - the observer's own cell and the target cell are never tested as
//!     blockers, which keeps LOS symmetric under endpoint swap;
//!   - a crossed cell blocks when its (max) height exceeds the ray height at
//!     the LOWER endpoint of the in-cell segment (conservative: a cell blocks
//!     if the ray dips to or below its plateau anywhere inside it) plus a
//!     grazing epsilon;
//!   - exact corner crossings advance BOTH grid axes at once so the traversed
//!     cell set — and therefore the verdict — is identical in either
//!     direction.
//!
//! Earth curvature is ignored, like E4. All units are the scene's own world
//! units on every axis (see the E5 scale calibration in `decision_tick` for
//! the horizontal metres-per-unit factor; the vertical axis is used exactly
//! as baked).

use std::io::Read;

/// Grazing tolerance for blocking tests — same value as the E4 baker's `_EPS`.
const EPS: f64 = 1e-6;

/// A baked terrain height raster in world (scene) units.
#[derive(Debug, Clone)]
pub struct LosGrid {
    res: usize,
    min_x: f64,
    max_x: f64,
    min_z: f64,
    max_z: f64,
    /// Row-major `[row * res + col]`, row 0 = minZ, col 0 = minX.
    heights: Vec<f32>,
}

impl LosGrid {
    /// Build a grid directly from baked parts (synthetic tests; the npz loader
    /// feeds the same fields). Validates the square-raster invariant.
    pub fn from_parts(
        res: usize,
        min_x: f64,
        max_x: f64,
        min_z: f64,
        max_z: f64,
        heights: Vec<f32>,
    ) -> Result<LosGrid, String> {
        // Checked: a crafted header can declare a res whose square overflows.
        let Some(expected) = res.checked_mul(res) else {
            return Err(format!("grid res {res} overflows usize"));
        };
        if res == 0 || heights.len() != expected {
            return Err(format!(
                "grid shape mismatch: res {res} needs {expected} heights, got {}",
                heights.len()
            ));
        }
        if !(max_x > min_x && max_z > min_z) {
            return Err("degenerate world bounds".to_string());
        }
        Ok(LosGrid {
            res,
            min_x,
            max_x,
            min_z,
            max_z,
            heights,
        })
    }

    /// Load the `terrain_los.npz` written by `bake_terrain_los.py`. Reads the
    /// `height` / `bounds` arrays (plus the `params` cross-check when present).
    pub fn load_npz(path: &std::path::Path) -> Result<LosGrid, String> {
        let file =
            std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
            .map_err(|e| format!("read {} as npz/zip: {e}", path.display()))?;
        let height_arr = read_npz_array(&mut zip, "height")?;
        let shape = height_arr.shape.clone();
        let heights = npy_to_f32("height", height_arr)?;
        let bounds = npy_to_f64("bounds", read_npz_array(&mut zip, "bounds")?)?;
        if bounds.len() != 4 {
            return Err(format!(
                "bounds array must hold [minX, maxX, minZ, maxZ], got {} values",
                bounds.len()
            ));
        }
        let (res, res1) = match (shape.first(), shape.get(1)) {
            (Some(a), Some(b)) => (*a, *b),
            _ => return Err("height array must be 2-dimensional".to_string()),
        };
        if res != res1 || res == 0 {
            return Err(format!("height raster must be square, shape {shape:?}"));
        }
        // params carries [res, obs_grid]; cross-check only when the member
        // decodes — height/bounds alone define the grid, so a missing or
        // undecodable params member is tolerated.
        if let Ok(arr) = read_npz_array(&mut zip, "params") {
            if let Ok(params) = npy_to_i32("params", arr) {
                if params.first() != Some(&(res as i32)) {
                    return Err(format!(
                        "params res {} disagrees with height shape {res}",
                        params.first().unwrap_or(&0)
                    ));
                }
            }
        }
        LosGrid::from_parts(res, bounds[0], bounds[1], bounds[2], bounds[3], heights)
    }

    /// Raster side length in cells. Diagnostics/tests only for now — the
    /// decision-tick path reads heights through `los_blocked` alone.
    #[allow(dead_code)]
    pub fn res(&self) -> usize {
        self.res
    }

    /// World bounds `(min_x, max_x, min_z, max_z)`. Diagnostics/tests only.
    #[allow(dead_code)]
    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        (self.min_x, self.max_x, self.min_z, self.max_z)
    }

    /// Cell holding the (max) height for a world point — `(row, col)`, each
    /// clamped into the raster.
    pub fn cell_of(&self, x: f64, z: f64) -> (usize, usize) {
        let col = ((x - self.min_x) / (self.max_x - self.min_x) * self.res as f64)
            .floor()
            .clamp(0.0, (self.res - 1) as f64) as usize;
        let row = ((z - self.min_z) / (self.max_z - self.min_z) * self.res as f64)
            .floor()
            .clamp(0.0, (self.res - 1) as f64) as usize;
        (row, col)
    }

    /// (Max) raster height of one cell.
    pub fn height(&self, row: usize, col: usize) -> f32 {
        self.heights[row * self.res + col]
    }

    /// (Max) raster height under a world point. Diagnostics/tests only.
    #[allow(dead_code)]
    pub fn height_at(&self, x: f64, z: f64) -> f32 {
        let (row, col) = self.cell_of(x, z);
        self.height(row, col)
    }
}

/// Whether terrain blocks the sight line from `(x, z, eye_h)` to
/// `(x, z, target_h)` — absolute world heights (sea level = 0). See the module
/// docs for the exact DDA semantics; endpoints outside the raster's world
/// rectangle are clamped onto its edge (a straight segment between two
/// interior points never leaves it, so the march itself stays in range).
pub fn los_blocked(grid: &LosGrid, from: (f64, f64, f64), to: (f64, f64, f64)) -> bool {
    let res = grid.res as f64;
    let span_x = grid.max_x - grid.min_x;
    let span_z = grid.max_z - grid.min_z;
    let (x0, z0, y0) = (
        from.0.clamp(grid.min_x, grid.max_x),
        from.1.clamp(grid.min_z, grid.max_z),
        from.2,
    );
    let (x1, z1, y1) = (
        to.0.clamp(grid.min_x, grid.max_x),
        to.1.clamp(grid.min_z, grid.max_z),
        to.2,
    );
    // Grid-space float coordinates (cell units).
    let fx0 = (x0 - grid.min_x) / span_x * res;
    let fz0 = (z0 - grid.min_z) / span_z * res;
    let fx1 = (x1 - grid.min_x) / span_x * res;
    let fz1 = (z1 - grid.min_z) / span_z * res;
    let (cr0, cc0) = grid.cell_of(x0, z0);
    let (cr1, cc1) = grid.cell_of(x1, z1);
    // Observer cell (start) and target cell (end), kept as i64 for the march.
    let (sr, sc) = (cr0 as i64, cc0 as i64);
    let (mut cr, mut cc) = (sr, sc);
    let (tr, tc) = (cr1 as i64, cc1 as i64);
    if (cr, cc) == (tr, tc) {
        return false;
    }
    let dc = fx1 - fx0;
    let dr = fz1 - fz0;
    let step_c = dc.signum() as i64;
    let step_r = dr.signum() as i64;
    let inf = f64::INFINITY;
    let (mut t_max_c, dt_c) = if dc > 0.0 {
        let dt = 1.0 / dc;
        // A start exactly on a gridline keeps its opening segment inside the
        // START cell under the half-open cell convention (the point moving
        // right from fx = k is in cell k) — the next boundary is one cell
        // further, not the one it stands on.
        let t = if fx0.ceil() == fx0 {
            dt
        } else {
            (fx0.ceil() - fx0) / dc
        };
        (t, dt)
    } else if dc < 0.0 {
        (((fx0.floor() - fx0) / dc), -1.0 / dc)
    } else {
        (inf, inf)
    };
    let (mut t_max_r, dt_r) = if dr > 0.0 {
        let dt = 1.0 / dr;
        let t = if fz0.ceil() == fz0 {
            dt
        } else {
            (fz0.ceil() - fz0) / dr
        };
        (t, dt)
    } else if dr < 0.0 {
        (((fz0.floor() - fz0) / dr), -1.0 / dr)
    } else {
        (inf, inf)
    };
    let dy = y1 - y0;
    let mut t = 0.0f64;
    let max_iters = 3 * (grid.res + grid.res) + 8;
    for _ in 0..max_iters {
        if cr == tr && cc == tc {
            // Arrived: the final in-cell segment is never tested (the target
            // is not its own blocker).
            return false;
        }
        let t_end = t_max_c.min(t_max_r).min(1.0);
        let ya = y0 + dy * t;
        let yb = y0 + dy * t_end;
        // The observer's own cell is never a blocker (mirroring the target
        // cell, this is what keeps LOS symmetric under endpoint swap). The
        // check is by cell identity, NOT t == 0: a start point lying exactly
        // on a gridline steps to the next cell at t == 0, and that crossed
        // cell still has to be tested.
        if (cr != sr || cc != sc)
            && f64::from(grid.height(cr as usize, cc as usize)) > ya.min(yb) + EPS
        {
            return true;
        }
        // The segment ends inside the CURRENT cell (no boundary is crossed
        // before t = 1), which is therefore the target cell — stop instead of
        // stepping past the endpoint. The E4 Python version gets this for free
        // by marching between cell CENTRES; exact world endpoints need the
        // explicit gate or accumulated crossing times can overshoot the grid.
        if t_end >= 1.0 {
            return false;
        }
        // Advance across the next cell boundary. Exact or near-exact corner
        // ties advance BOTH axes so the traversed cell set is identical in
        // either direction (required for swap symmetry).
        let tie = (t_max_c - t_max_r).abs() < 1e-9;
        let cross_c = t_max_c < t_max_r || tie;
        let cross_r = t_max_r < t_max_c || tie;
        t = t_end;
        if cross_c {
            t_max_c += dt_c;
            cc += step_c;
        }
        if cross_r {
            t_max_r += dt_r;
            cr += step_r;
        }
    }
    false
}

// ── npz / npy reading (zip container + minimal .npy header parser) ─────────

/// One decoded `.npy` member: dtype descriptor, shape, raw little-endian data.
struct NpyArray {
    descr: String,
    shape: Vec<usize>,
    data: Vec<u8>,
}

/// Read one `<name>.npy` member out of an npz archive.
fn read_npz_array<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<NpyArray, String> {
    let entry_name = format!("{name}.npy");
    let mut entry = zip
        .by_name(&entry_name)
        .map_err(|e| format!("npz member {entry_name}: {e}"))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read npz member {entry_name}: {e}"))?;
    parse_npy(&entry_name, &bytes)
}

/// Parse the `.npy` v1/v2/v3 format: `\\x93NUMPY` magic, version bytes, header
/// length (u16 for v1, u32 for v2+), ASCII header dict, then raw data.
/// Fortran-ordered arrays are rejected (the baker always writes C order).
fn parse_npy(name: &str, bytes: &[u8]) -> Result<NpyArray, String> {
    const MAGIC: &[u8; 6] = b"\x93NUMPY";
    if bytes.len() < 10 || &bytes[..6] != MAGIC {
        return Err(format!("{name}: not an npy payload"));
    }
    let (hlen, off) = match bytes[6] {
        1 => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
        2 | 3 => {
            if bytes.len() < 12 {
                return Err(format!(
                    "{name}: truncated npy v{} header (needs 12 bytes)",
                    bytes[6]
                ));
            }
            (
                u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
                12,
            )
        },
        v => return Err(format!("{name}: unsupported npy version {v}.0")),
    };
    if bytes.len() < off + hlen {
        return Err(format!("{name}: truncated npy header"));
    }
    let header = std::str::from_utf8(&bytes[off..off + hlen])
        .map_err(|e| format!("{name}: npy header not UTF-8: {e}"))?;
    if header.contains("'fortran_order': True") {
        return Err(format!("{name}: fortran order not supported"));
    }
    let descr = quoted_header_value(header, "'descr'")
        .ok_or_else(|| format!("{name}: npy header has no descr"))?;
    let shape =
        shape_header_value(header).ok_or_else(|| format!("{name}: npy header has no shape"))?;
    Ok(NpyArray {
        descr,
        shape,
        data: bytes[off + hlen..].to_vec(),
    })
}

/// Value of a `'key': 'value'` string entry in an npy header dict.
fn quoted_header_value(header: &str, key: &str) -> Option<String> {
    let key_at = header.find(key)?;
    let colon = header[key_at..].find(':')? + key_at;
    let open = header[colon..].find('\'')? + colon + 1;
    let close = header[open..].find('\'')? + open;
    Some(header[open..close].to_string())
}

/// Values of the `'shape': (a, b, ...)` entry in an npy header dict.
fn shape_header_value(header: &str) -> Option<Vec<usize>> {
    let key_at = header.find("'shape'")?;
    let open = header[key_at..].find('(')? + key_at;
    let close = header[open..].find(')')? + open;
    let inner = &header[open + 1..close];
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }
    // NumPy writes single-element tuples as "(4,)" — drop the empty piece
    // the trailing comma produces.
    inner
        .split(',')
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim().parse::<usize>().ok())
        .collect()
}

/// Element count implied by an npy shape, rejecting overflow (crafted
/// headers can declare dims whose product exceeds usize).
fn npy_elems(name: &str, shape: &[usize]) -> Result<usize, String> {
    shape
        .iter()
        .try_fold(1usize, |acc, &d| acc.checked_mul(d))
        .ok_or_else(|| format!("{name}: shape element count overflows"))
}

fn npy_to_f32(name: &str, arr: NpyArray) -> Result<Vec<f32>, String> {
    if arr.descr != "<f4" {
        return Err(format!("{name}: expected dtype <f4, got {}", arr.descr));
    }
    let count = npy_elems(name, &arr.shape)?;
    let need = count
        .checked_mul(4)
        .ok_or_else(|| format!("{name}: shape byte count overflows"))?;
    if arr.data.len() < need {
        return Err(format!("{name}: truncated {count} f32 values"));
    }
    Ok(arr
        .data
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

fn npy_to_f64(name: &str, arr: NpyArray) -> Result<Vec<f64>, String> {
    if arr.descr != "<f8" {
        return Err(format!("{name}: expected dtype <f8, got {}", arr.descr));
    }
    let count = npy_elems(name, &arr.shape)?;
    let need = count
        .checked_mul(8)
        .ok_or_else(|| format!("{name}: shape byte count overflows"))?;
    if arr.data.len() < need {
        return Err(format!("{name}: truncated {count} f64 values"));
    }
    Ok(arr
        .data
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
        .collect())
}

fn npy_to_i32(name: &str, arr: NpyArray) -> Result<Vec<i32>, String> {
    if arr.descr != "<i4" {
        return Err(format!("{name}: expected dtype <i4, got {}", arr.descr));
    }
    let count = npy_elems(name, &arr.shape)?;
    let need = count
        .checked_mul(4)
        .ok_or_else(|| format!("{name}: shape byte count overflows"))?;
    if arr.data.len() < need {
        return Err(format!("{name}: truncated {count} i32 values"));
    }
    Ok(arr
        .data
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// The E4 selftest's synthetic terrain: one dominant 40-unit Gaussian
    /// hill centred at (-150, 100) (sigma 90) plus a small 12-unit hill at
    /// (380, -320) (sigma 70), rasterised exactly onto the cell centres so the
    /// grid is round-trip exact.
    fn synthetic_hill_grid() -> LosGrid {
        let res = 96usize;
        let extent = 1200.0_f64;
        let mut heights = Vec::with_capacity(res * res);
        for r in 0..res {
            let z = (r as f64 + 0.5) / res as f64 * extent - extent / 2.0;
            for c in 0..res {
                let x = (c as f64 + 0.5) / res as f64 * extent - extent / 2.0;
                let big = 40.0
                    * (-((x + 150.0).powi(2) + (z - 100.0).powi(2)) / (2.0 * 90.0_f64.powi(2)))
                        .exp();
                let small = 12.0
                    * (-((x - 380.0).powi(2) + (z + 320.0).powi(2)) / (2.0 * 70.0_f64.powi(2)))
                        .exp();
                heights.push((big + small) as f32);
            }
        }
        LosGrid::from_parts(
            res,
            -extent / 2.0,
            extent / 2.0,
            -extent / 2.0,
            extent / 2.0,
            heights,
        )
        .expect("synthetic grid")
    }

    /// A flat sea map never blocks anything, whatever the heights flown.
    #[test]
    fn flat_map_never_blocks() {
        let grid = LosGrid::from_parts(8, 0.0, 80.0, 0.0, 80.0, vec![0.0; 64]).expect("grid");
        for (x0, z0, x1, z1) in [
            (5.0, 5.0, 75.0, 75.0),
            (1.0, 40.0, 79.0, 40.0),
            (40.0, 1.0, 40.0, 79.0),
        ] {
            assert!(!los_blocked(&grid, (x0, z0, 5.0), (x1, z1, 0.0)));
            assert!(!los_blocked(&grid, (x1, z1, 0.0), (x0, z0, 5.0)));
        }
    }

    /// A low observer east of the dominant hill is shadowed on the far (west)
    /// side and sees the near side; standing the eye up restores the far side.
    #[test]
    fn hill_shadows_the_far_side() {
        let grid = synthetic_hill_grid();
        // Observer far EAST of the hill, same latitude (hill centre z = 100).
        let obs = (520.0, 100.0);
        // Directly west behind the hill, sea level.
        assert!(los_blocked(
            &grid,
            (obs.0, obs.1, 5.0),
            (-500.0, 100.0, 0.0)
        ));
        // Near side (east of the hill, clear water) stays visible.
        assert!(!los_blocked(
            &grid,
            (obs.0, obs.1, 5.0),
            (400.0, 100.0, 0.0)
        ));
        // Raising the eye far above the 40-unit summit clears the shadow (the
        // ray still dips: at eye 80 its height over the summit is only ~27).
        assert!(!los_blocked(
            &grid,
            (obs.0, obs.1, 150.0),
            (-500.0, 100.0, 0.0)
        ));
        // Same cell degenerates to unblocked.
        assert!(!los_blocked(
            &grid,
            (obs.0, obs.1, 5.0),
            (obs.0, obs.1, 5.0)
        ));
    }

    /// LOS is symmetric under endpoint swap over random hill-terrain pairs
    /// (the corner-tie handling exists exactly for this).
    #[test]
    fn los_is_symmetric_under_swap() {
        let grid = synthetic_hill_grid();
        // Deterministic xorshift RNG (no rand dependency).
        let mut state = 0x9E3779B97F4A7C15u64;
        let next = |s: &mut u64| {
            *s ^= *s << 13;
            *s ^= *s >> 7;
            *s ^= *s << 17;
            *s
        };
        let coord = |s: &mut u64| (next(s) % 1200) as f64 - 600.0;
        let eye_off = 5.0f64;
        let mut pairs = 0usize;
        for _ in 0..300 {
            let (mut x0, mut z0, mut x1, mut z1) = (
                coord(&mut state),
                coord(&mut state),
                coord(&mut state),
                coord(&mut state),
            );
            if x0 > x1 {
                std::mem::swap(&mut x0, &mut x1);
            }
            if z0 > z1 {
                std::mem::swap(&mut z0, &mut z1);
            }
            let y0 = f64::from(grid.height_at(x0, z0)) + eye_off;
            let y1 = f64::from(grid.height_at(x1, z1)) + eye_off;
            let a = los_blocked(&grid, (x0, z0, y0), (x1, z1, y1));
            let b = los_blocked(&grid, (x1, z1, y1), (x0, z0, y0));
            assert_eq!(
                a, b,
                "LOS asymmetry at ({x0:.1},{z0:.1})->({x1:.1},{z1:.1})"
            );
            pairs += 1;
        }
        assert!(pairs > 200);
    }

    /// Endpoint cells are never blockers: a wall column blocks a sea-level ray
    /// through it, but a target STANDING on the wall sees (and is seen) over
    /// its own cell.
    #[test]
    fn endpoint_cells_never_block() {
        // 16×16 grid, 10 units per cell, one 100-unit wall at column 8.
        let res = 16usize;
        let mut heights = vec![0.0f32; res * res];
        for r in 0..res {
            heights[r * res + 8] = 100.0;
        }
        let grid = LosGrid::from_parts(res, 0.0, 160.0, 0.0, 160.0, heights).expect("grid");
        // Sea-level ray west → east passes through the wall cell: blocked.
        assert!(los_blocked(&grid, (5.0, 80.0, 10.0), (150.0, 80.0, 0.0)));
        // Target standing ON the wall (eye above its 100-unit top): its own
        // cell is excluded, and nothing else is high → visible.
        assert!(!los_blocked(&grid, (5.0, 80.0, 10.0), (85.0, 80.0, 110.0)));
        // Observer on the wall looking west: own cell excluded → visible.
        assert!(!los_blocked(&grid, (85.0, 80.0, 110.0), (5.0, 80.0, 10.0)));
    }

    /// Endpoints outside the raster clamp onto its edge instead of panicking.
    #[test]
    fn out_of_bounds_endpoints_clamp() {
        let grid = synthetic_hill_grid();
        // Both endpoints far outside the ±600 extent on the same latitude as
        // the hill: clamping pulls them to the edge cells, ray runs along the
        // row through the hill → blocked at a low eye, clear when very high.
        assert!(los_blocked(
            &grid,
            (-5000.0, 100.0, 5.0),
            (5000.0, 100.0, 0.0)
        ));
        assert!(!los_blocked(
            &grid,
            (-5000.0, 100.0, 500.0),
            (5000.0, 100.0, 0.0)
        ));
    }

    /// Write a minimal npz (zip of npy members, deflate — the same shape
    /// `np.savez_compressed` produces) and read it back through the loader.
    #[test]
    fn npz_round_trip() {
        fn npy_bytes(descr: &str, shape: &[usize], data: &[u8]) -> Vec<u8> {
            let shape_txt = shape
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            let dict =
                format!("{{'descr': '{descr}', 'fortran_order': False, 'shape': ({shape_txt}), }}");
            // numpy pads the header (spaces + trailing newline) so the magic +
            // version + u16 length + header total is 64-byte aligned.
            let mut hlen = dict.len() + 1;
            if (10 + hlen) % 64 != 0 {
                hlen += 64 - (10 + hlen) % 64;
            }
            let spaces = hlen - dict.len() - 1;
            let mut out = Vec::with_capacity(10 + hlen + data.len());
            out.extend_from_slice(b"\x93NUMPY");
            out.extend_from_slice(&[1, 0]);
            out.extend_from_slice(&(hlen as u16).to_le_bytes());
            out.extend_from_slice(dict.as_bytes());
            out.extend(std::iter::repeat_n(b' ', spaces));
            out.push(b'\n');
            out.extend_from_slice(data);
            out
        }

        let res = 16usize;
        let mut heights = vec![0.0f32; res * res];
        heights[3 * res + 4] = 42.0;
        let height_data: Vec<u8> = heights.iter().flat_map(|h| h.to_le_bytes()).collect();
        let bounds_data: Vec<u8> = [0.0f64, 160.0, 0.0, 160.0]
            .iter()
            .flat_map(|b| b.to_le_bytes())
            .collect();
        let params_data: Vec<u8> = [res as i32, 4i32]
            .iter()
            .flat_map(|p| p.to_le_bytes())
            .collect();

        let dir = std::env::temp_dir().join("wowsp_terrain_los_test");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("round_trip.npz");
        let file = std::fs::File::create(&path).expect("create");
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("height.npy", opts).expect("write height");
        zip.write_all(&npy_bytes("<f4", &[res, res], &height_data))
            .expect("height data");
        zip.start_file("bounds.npy", opts).expect("write bounds");
        zip.write_all(&npy_bytes("<f8", &[4], &bounds_data))
            .expect("bounds data");
        zip.start_file("params.npy", opts).expect("write params");
        zip.write_all(&npy_bytes("<i4", &[2], &params_data))
            .expect("params data");
        zip.finish().expect("finish zip");

        let grid = LosGrid::load_npz(&path).expect("load round-trip npz");
        assert_eq!(grid.res(), res);
        assert_eq!(grid.bounds(), (0.0, 160.0, 0.0, 160.0));
        assert_eq!(grid.height(3, 4), 42.0);
        // The single 42-unit pillar blocks a low ray through it, exactly like
        // the from_parts grid would.
        assert!(los_blocked(&grid, (5.0, 35.0, 5.0), (155.0, 35.0, 0.0)));
        assert!(!los_blocked(&grid, (5.0, 5.0, 5.0), (155.0, 5.0, 0.0)));
        // A mismatched params res must be rejected.
        let bad = dir.join("bad_params.npz");
        let file = std::fs::File::create(&bad).expect("create bad");
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("height.npy", opts).expect("write height");
        zip.write_all(&npy_bytes("<f4", &[res, res], &height_data))
            .expect("height data");
        zip.start_file("bounds.npy", opts).expect("write bounds");
        zip.write_all(&npy_bytes("<f8", &[4], &bounds_data))
            .expect("bounds data");
        zip.start_file("params.npy", opts).expect("write params");
        zip.write_all(&npy_bytes(
            "<i4",
            &[2],
            &[99i32, 4]
                .iter()
                .flat_map(|p| p.to_le_bytes())
                .collect::<Vec<u8>>(),
        ))
        .expect("params data");
        zip.finish().expect("finish bad zip");
        assert!(LosGrid::load_npz(&bad).is_err());
    }

    /// Real 50_Gold_harbor raster (E4 output) — run with
    /// `WOWSP_TEST_LOS_GRID=<path>`; defaults to the worktree's baked copy and
    /// skips when absent. Verifies the loader against baker-known facts and
    /// reports occlusion statistics for eyeballing.
    #[test]
    fn loads_real_gold_harbor_raster() {
        let Ok(path) = std::env::var("WOWSP_TEST_LOS_GRID") else {
            let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../scripts/experiments/out/50_Gold_harbor/terrain_los.npz");
            if !default.exists() {
                eprintln!("[los] no WOWSP_TEST_LOS_GRID and no default raster - skipping");
                return;
            }
            return check_real_raster(&default);
        };
        check_real_raster(std::path::Path::new(&path));
    }

    fn check_real_raster(path: &std::path::Path) {
        let grid = LosGrid::load_npz(path).expect("load real raster");
        let (min_x, max_x, min_z, max_z) = grid.bounds();
        eprintln!(
            "[los] {} res={} bounds x[{min_x:.0},{max_x:.0}] z[{min_z:.0},{max_z:.0}] max_height={:.3} land_fraction={:.4}",
            path.display(),
            grid.res(),
            grid.heights.iter().cloned().fold(f32::MIN, f32::max),
            grid.heights.iter().filter(|h| **h > EPS as f32).count() as f32
                / (grid.res() * grid.res()) as f32
        );
        // The E4 bake of 50_Gold_harbor (res 256, minimaps.json bounds
        // ±(-700/600)) — sanity only, not exact assertions on land stats.
        assert_eq!(grid.res(), 256);
        assert!((min_x - -700.0).abs() < 1.0 && (max_x - 600.0).abs() < 1.0);
        assert!((min_z - -700.0).abs() < 1.0 && (max_z - 600.0).abs() < 1.0);
        // A pair of sea-level points across open water must see each other.
        let mut sea_pair = None;
        'outer: for r in (0..grid.res()).step_by(7) {
            for c in (0..grid.res()).step_by(7) {
                if grid.height(r, c) > EPS as f32
                    || grid.height(r, c + 7.min(grid.res() - c - 1)) > EPS as f32
                {
                    continue;
                }
                let z0 = min_z + (r as f64 + 0.5) / grid.res() as f64 * (max_z - min_z);
                let x0 = min_x + (c as f64 + 0.5) / grid.res() as f64 * (max_x - min_x);
                let x1 = min_x + (c as f64 + 7.5) / grid.res() as f64 * (max_x - min_x);
                sea_pair = Some(((x0, z0), (x1, z0)));
                break 'outer;
            }
        }
        if let Some((a, b)) = sea_pair {
            assert!(!los_blocked(&grid, (a.0, a.1, 20.0), (b.0, b.1, 0.0)));
        }
    }
}
