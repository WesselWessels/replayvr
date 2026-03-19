mod parse;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("Usage: rl-parser <replay_file>");
    let data = std::fs::read(path).expect("Could not read replay file");
    match parse::parse(&data) {
        Ok(output) => println!("{}", serde_json::to_string(&output).unwrap()),
        Err(e) => { eprintln!("{e}"); std::process::exit(1); }
    }
}
