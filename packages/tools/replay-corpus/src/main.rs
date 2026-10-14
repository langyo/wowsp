//! The replay-corpus CLI's entry point: argv → archive aggregation. All
//! policy lives in the lib (host-testable); this binary only moves bytes
//! between the drained archive and the maintainer's dataset files.

use anyhow::Result;
use replay_corpus::{Command, parse_args, run_insights, run_scan};

const HELP: &str = "\
replay-corpus — the replay-share corpus CLI

  replay-corpus scan      [options]   index every drained replay's header
                                       (archive/raw/*) into a JSON array
  replay-corpus insights  [options]   decode every drained replay (worker
                                       pool) and aggregate map-insights.json:
                                       per (map, mode) battle counts, the
                                       modal cap layout and 96x96 spawn/track
                                       heat grids (self-calibrating bounds)

Options (env fallbacks in parentheses):
  --archive <dir>  the drained archive (WOWSP_ARCHIVE_DIR, default
                   ./replay-archive — whatever replay-drain pull wrote)
  --out <path>     scan: index output (default ./index.json); insights:
                   dataset output (default ./map-insights.json)
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
