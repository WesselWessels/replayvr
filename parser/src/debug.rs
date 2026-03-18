use boxcars::ParserBuilder;
use std::fs;

fn main() {
    let data = fs::read(std::env::args().nth(1).unwrap()).unwrap();
    let replay = ParserBuilder::new(&data).on_error_check_crc().parse().unwrap();
    eprintln!("=== Objects containing boost/pickup ===");
    for (i, obj) in replay.objects.iter().enumerate() {
        let lower = obj.to_lowercase();
        if lower.contains("pickup") || lower.contains("boost") || lower.contains("vehicle") {
            eprintln!("{}: {}", i, obj);
        }
    }
    // Also check what object_id new actors get
    if let Some(ref nf) = replay.network_frames {
        let mut shown = 0;
        for frame in &nf.frames {
            for na in &frame.new_actors {
                let name = replay.objects.get(na.object_id.0 as usize).map(|s| s.as_str()).unwrap_or("?");
                let lower = name.to_lowercase();
                if lower.contains("pickup") || lower.contains("boost") {
                    eprintln!("NewActor obj_id={} name={} loc={:?}", na.object_id.0, name, na.initial_trajectory.location);
                    shown += 1;
                    if shown > 5 { break; }
                }
            }
            if shown > 5 { break; }
        }
    }
}
