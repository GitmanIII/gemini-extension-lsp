pub struct RustTest;

impl RustTest {
    pub fn hello(&self) -> &str {
        123 // Error: expected &str, found i32
    }
}

fn main() {
    let test = RustTest;
    println!("{}", test.wrong()); // Error: no method named 'wrong'
}