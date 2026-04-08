export class TypeScriptTest {
	public hello(): string {
		return 123; // Error: should be string
	}
}
const tsTest = new TypeScriptTest();
console.log(tsTest.hello(1)); // Error: too many arguments
