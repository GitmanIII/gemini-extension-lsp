interface ITest {
	hello(): string;
}

export class TypeScriptTest implements ITest {
	public hello(): string {
		return "world";
	}
}

const tsTest = new TypeScriptTest();
console.log(tsTest.hello());

// To test rename:
// 1. Rename 'TypeScriptTest' (Line 4) to 'GptLspTest'
// 2. Check Line 10 update
