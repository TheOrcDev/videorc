/// Lowercase hex for digest outputs.
///
/// sha2 0.11 returns a byte array that does not implement `LowerHex`, so
/// `format!("{:x}", digest)` no longer compiles.
pub fn lower_hex(bytes: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = bytes.as_ref();
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_lowercase_hex() {
        assert_eq!(super::lower_hex([0x0a, 0xff, 0x10]), "0aff10");
    }
}
