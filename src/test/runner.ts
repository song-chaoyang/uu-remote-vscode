/**
 * 极简测试运行器(在 VSCode 扩展宿主内由 --extensionTestsPath 加载协议调用 run())。
 * 自包含实现,不依赖 mocha 在扩展宿主中的可用性。
 */
type TestFn = () => void | Promise<void>;
type SuiteFn = () => void;

interface TestCase {
  name: string;
  fn: TestFn;
}

const tests: TestCase[] = [];

export function suite(_name: string, fn: SuiteFn): void {
  // 顺序执行 suite 体以注册其中的 test(顶层无异步需求)
  fn();
}

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export async function run(): Promise<void> {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL  ${t.name}`);
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }
  console.log(`\n== 集成测试结果: ${tests.length - failures} 通过, ${failures} 失败 ==\n`);
  if (failures > 0) {
    throw new Error(`${failures} 个集成测试失败`);
  }
}
