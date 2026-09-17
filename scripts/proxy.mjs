#!/usr/bin/env node
/**
 * proxy.mjs — 让脚本走系统代理（内部模块）
 *
 * ## 为什么需要这个
 *
 * Node 的 `fetch` 默认**不使用代理**。Windows 上的代理设置
 * （Clash / v2ray 之类）通常只写进注册表的 `Internet Settings`，
 * 不写环境变量 —— 而 Node 只看环境变量。
 *
 * 结果：浏览器能访问 Google，Node 直连超时 —— 表现为 `fetch failed`，
 * 而那个报错完全看不出是代理问题。
 *
 * 这是实测撞出来的：Gmail 授权时浏览器显示"授权成功"，
 * 但用授权码换令牌那一步 `fetch failed`。查下来系统代理
 * `127.0.0.1:7890` 在跑，而 Node 环境里一个代理变量都没有。
 *
 * ## 关键发现：Node 24 支持代理，但开关必须在**启动前**设好
 *
 * 实测三种方式：
 *
 *   在 PowerShell 里设 $env:HTTPS_PROXY 再跑        ✗ 还是 fetch failed
 *   在脚本里 process.env.HTTPS_PROXY = …            ✗ 同上
 *   NODE_USE_ENV_PROXY=1 + HTTPS_PROXY（启动前）    ✓ 通了
 *
 * 也就是**运行时改 process.env 没用** —— Node 在启动时就读定了。
 * 所以只能重启一次进程。
 *
 * ## 怎么用
 *
 * 在最需要联网的脚本顶部（import 之后、任何 fetch 之前）加一行：
 *
 *     import { restartIfNeeded } from './proxy.mjs';
 *     restartIfNeeded();
 *
 * 需要重启时它不会返回 —— 它会把当前脚本用正确的环境重跑一遍，
 * 然后以同样的退出码结束当前进程。调用方不需要处理返回值。
 *
 * 不需要重启时它立刻返回 false，继续往下跑。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

/** 环回地址不走代理 —— OAuth 的本地回调必须直连。 */
const NO_PROXY = 'localhost,127.0.0.1,::1';

/** 从环境变量或 Windows 注册表里找代理地址。找不到返回 null。 */
export function resolveProxyUrl() {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (fromEnv) return fromEnv.trim();

  if (process.platform !== 'win32') return null;

  // 读注册表。静默失败 —— 没有代理是正常情况，不该报错。
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "$k=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; if($k.ProxyEnable -eq 1){$k.ProxyServer}",
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    ).trim();
    if (!out) return null;
    return out.includes('://') ? out : `http://${out}`;
  } catch {
    return null;
  }
}

/**
 * 需要时重启当前脚本，让它带上代理开关。
 *
 * @returns {false} 不需要重启时
 * @returns {never} 需要重启时 —— 重跑完就 process.exit，不返回
 */
export function restartIfNeeded() {
  // 已经有开关了
  if (process.env.NODE_USE_ENV_PROXY === '1') {
    installCleanExit();
    return false;
  }
  // 防重启循环
  if (process.env.__PROXY_RELAUNCHED === '1') {
    installCleanExit();
    return false;
  }

  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) return false; // 没有代理就走直连

  const entry = process.argv[1];
  if (!entry) return false;

  const r = spawnSync(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NO_PROXY,
      __PROXY_RELAUNCHED: '1',
    },
  });

  process.exit(r.status ?? 1);
}

/**
 * 关于退出码：**已知未解决问题，不是忘了。**
 *
 * 现象：走代理发过请求之后，Node 在 Windows 上退出时打印
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
 *     file src\win\async.c, line 76
 *
 * 退出码变成 3221226505（0xC0000409），而**输出是完整正确的**。
 *
 * 已试过、**都没用**的办法：
 *
 *   process.on('exit', () => process.reallyExit(code))   部分生效，不稳定
 *   父进程侧用 reallyExit 退出                            反而更糟（0/6）
 *   用环境变量做防重复安装标记                             引入了新 bug（见下）
 *
 * 试出来的一个坑值得留着：**不要用环境变量做"只装一次"的标记。**
 * 重启出来的子进程会继承父进程的环境，于是子进程看到标记就跳过安装 ——
 * 症状是"时好时坏"（崩的是父进程还是子进程取决于哪一侧先清理句柄）。
 *
 * 结论：这是 Node/libuv 在 Windows 上处理 libuv 句柄清理的问题，
 * 触发条件是设了 NODE_USE_ENV_PROXY 并真的走了代理。
 * **不影响功能，只影响退出码。**
 *
 * 如果有脚本要判断成功与否：**看输出，不要看退出码**。
 * 比如取信成功的标志是输出里有"新处理 N 封"或"跳过已处理 N 封"。
 */
function installCleanExit() {
  process.on('exit', (code) => {
    process.reallyExit(typeof code === 'number' ? code : 0);
  });
}

// 模块加载时就装 —— 见上面那段"为什么"
installCleanExit();

/** 代理状态，给 --status 之类的命令显示用。 */
export function proxyStatus() {
  const url = resolveProxyUrl();
  return { configured: url, active: process.env.NODE_USE_ENV_PROXY === '1' && Boolean(url) };
}
