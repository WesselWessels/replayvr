mod parse;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_replay(data: &[u8]) -> Result<String, JsValue> {
    parse::parse(data)
        .map(|output| serde_json::to_string(&output).unwrap())
        .map_err(|e| JsValue::from_str(&e))
}
