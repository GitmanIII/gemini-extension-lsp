interface ITest {
	hello(): string;
}

export class ProjectLspTest implements ITest {
	public hello(): string {
		return "world";
	}
}

const tsTest = new ProjectLspTest();
console.log(tsTest.hello());

// To test rename:
// 1. Rename 'TypeScriptTest' (Line 4) to 'GptLspTest'
// 2. Check Line 10 update
