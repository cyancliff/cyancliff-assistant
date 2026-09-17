// 在任意平台上跑 .sh 测试 —— 目前只有 scripts/test-hooks.sh 用它。
//
// 为什么需要它：`npm run test` 在 Windows 上是由 cmd.exe 执行的，PATH 里没有 `sh`。
// 而钩子是 sh 写的，只能用 sh 测。直接写 `sh scripts/test-hooks.sh` 在别人的机器上会失败，
// 于是那条测试就永远没人跑 —— 这正是本项目刚修过一次的问题
// （文档说"一条命令跑完所有自测"，而链里漏了一项）。
//
// 不去猜 PATH，而是问 git 自己装在哪 —— 这个项目本来就要求装 git，
// 有 git 就一定有它自带的 sh。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const script = process.argv[2]
if (!script) {
  console.error('用法: node scripts/run-sh.mjs <脚本.sh> [参数…]')
  process.exit(2)
}

function findSh() {
  if (process.platform !== 'win32') return 'sh'

  // git --exec-path → …\Git\mingw64\libexec\git-core；往上三层就是 Git 的安装根目录
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout) {
    const root = path.resolve(r.stdout.trim(), '..', '..', '..')
    for (const rel of ['bin\\sh.exe', 'usr\\bin\\sh.exe']) {
      const p = path.join(root, rel)
      if (existsSync(p)) return p
    }
  }

  // 退路：让 PATH 去解决。找不到时下面会给出 exit 1 和一条能看懂的错，
  // 而不是一个空白的失败。
  return 'sh'
}

const sh = findSh()
const res = spawnSync(sh, [script, ...process.argv.slice(3)], { stdio: 'inherit' })

if (res.error) {
  console.error(`无法执行 ${sh}：${res.error.message}`)
  console.error('需要 Git（Windows 上装 Git for Windows 即可，它自带 sh）。')
  process.exit(1)
}

process.exit(res.status ?? 1)
