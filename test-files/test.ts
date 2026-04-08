interface ITest {
	hello(): string;
}

export class GptLspTest implements ITest {
	public hello(): string {
		return "world";
	}
}

const tsTest = new GptLspTest();
console.log(tsTest.hello());

// To test rename:
// 1. Rename 'TypeScriptTest' (Line 4) to 'GptLspTest'
// 2. Check Line 10 update
