//! The replay-corpus CLI's entry point: argv → archive aggregation. All
//! policy lives in the lib (host-testable); this binary only moves bytes
//! between the drained archive and the maintainer's dataset files.

use anyhow::Result;
use replay_corpus::{Command, parse_args, run_calib, run_insights, run_scan};

const HELP: &str = "\
replay-corpus — the replay-share corpus CLI

  replay-corpus scan      [options]   index every drained replay's header
                                       (archive/raw/*) into a JSON array
  replay-corpus insights  [options]   decode every drained replay (worker
                                       pool) and aggregate map-insights.json:
                                       per (map, mode) battle counts, the
                                       modal cap layout and 96x96 spawn/track
                                       heat grids (self-calibrating bounds);
                                       a heat-free map-insights-lite.json
                                       companion (battleCount/capsSample/
                                       caps per mode) lands next to it
  replay-corpus calib     [options]   decode every drained replay through the
                                       SETTLED self-stream assembly and write
                                       the stats-calibration bench corpus:
                                       one LiveSelfStream JSON per NDJSON
                                       line (only decodable battles, sha
                                       order) — regenerate the webui's
                                       __fixtures__/calib-corpus.ndjson with
                                       it (liveSelfCalibrationCorpus.test.ts)

Options (env fallbacks in parentheses):
  --archive <dir>  the drained archive (WOWSP_ARCHIVE_DIR, default
                   ./replay-archive — whatever replay-drain pull wrote)
  --out <path>     scan: index output (default ./index.json); insights:
                   dataset output (default ./map-insights.json; the lite
                   companion takes this path's stem plus -lite); calib:
                   corpus output (default ./calib-corpus.ndjson)
";

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match parse_args(&argv) {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("{e}\n\n{HELP}");
            std::process::exit(2);
        },
    };
    let run: Result<replay_corpus::RunReport> = match cmd {
        Command::Scan(args) => run_scan(&args.archive, &args.out),
        Command::Insights(args) => run_insights(&args.archive, &args.out, chrono::Utc::now()),
        Command::Calib(args) => run_calib(&args.archive, &args.out),
    };
    match run {
        Ok(report) => {
            println!(
                "processed {} replay(s), {} unparsed",
                report.files, report.unparsed
            );
        },
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        },
    }
}
