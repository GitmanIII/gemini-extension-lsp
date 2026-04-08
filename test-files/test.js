class JavaScriptTest {
  hello() {
    return "world";
  }
}
const jsTest = new JavaScriptTest();
console.log(jsTest.wrong()); // Error: method doesn't exist