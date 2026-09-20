#!/bin/sh
# 公开仓 pre-push 钩子的突变测试（scripts/test-hooks.sh）。
#
# 这个钩子唯一的职责是：不让个人数据进公开仓。所以它的测试不能只跑
# "干净状态通过" —— 那在钩子完全失效时也是通过的。必须**造出本该被拦的东西**，
# 看它拦不拦得住。这个项目里已经有三处断言是恒真的，都是靠这种方法才发现的。
#
# 两个已经踩过的坑，写在这里免得重犯：
#
#   1. 输入必须用 printf 生成，不能用会写 CRLF 的工具（PowerShell 管道、
#      带 BOM 的 Set-Content）。`git mktree` 会把 \r 当成文件名的一部分，
#      于是树里的路径叫 "Personal Memory\r" —— 测试看起来在测，其实没测。
#   2. "钩子在硬盘上"不等于"git 会执行它"。core.hooksPath 没设、mode 不是
#      100755，git 都会安静地跳过。所以第 4 步用 `git hook run` 证明它真被调用。
#
# 全部离线，不碰网络、不推任何东西。

set -u

# ── git 身份：自带，不依赖宿主的全局配置 ──────────────────────
#
# 这个脚本用 `git commit-tree` 造测试用的树，而 `commit-tree` 需要一个身份。
# 本机有 `~/.gitconfig`，所以一直没事；**CI 的 runner 没有**，于是：
#
#     fatal: empty ident name (for <runner@runnervmlun5p...>) not allowed
#
# `commit-tree` 失败 → `$c_gitlink` / `$c_env` 变成空字符串 → 钩子收到的
# "远端 sha" 全是 0（它把这个理解成"新建分支、此前什么都没有"）→ 放行，
# 于是两条断言报「期望 1，实际 0」。
#
# 这就是 CI 第三次红的原因（2026-09-20），而且它**和前两条是同一类**：
# 测试依赖了一件"本机才有的东西"。前一条是 `core.hooksPath`，这一条是全局 git 身份。
#
# 用环境变量而不是 `git config`：前者只作用于这条命令，
# **不写进任何配置文件**（CI 的 runner 是共享的，改它的全局配置不合适）。
# 身份是测试自己造的，与"谁在提交"无关 —— 它只是 plumbing 需要的一个字段。
# 注意：如果宿主**已经**配了身份，这里也会覆盖掉，但那无关紧要：
# 这个脚本产的 commit 从不落到任何分支上，只是喂给钩子看的对象。
GIT_AUTHOR_NAME='hook-test'
GIT_AUTHOR_EMAIL='hook-test@local'
GIT_COMMITTER_NAME='hook-test'
GIT_COMMITTER_EMAIL='hook-test@local'
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

hook=.githooks/pre-push
public_url=git@github.com:cyancliff/cyancliff-assistant.git
private_url=git@github.com:cyancliff/personal-memory.git
Z=0000000000000000000000000000000000000000

fail=0
chk() { # chk 描述 期望 实际
  total=$((total + 1))
  if [ "$2" = "$3" ]; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1（期望 $2，实际 $3）"
    fail=1
  fi
}

# 数出来的，不写死。
#
# 原先收尾写的是"全部通过（5 项）" —— 而这一步从 5 条长到了 8 条。
# **写死的数字是恒真断言**：它永远不会失败，所以永远发现不了自己过期。
# 这个项目在 contract.mjs 与 publish.mjs 里刚修过同一类问题。
total=0

echo "公开仓 pre-push 钩子 · 突变测试"

# ---- 造测试用的树（纯 plumbing，不动工作区、不动索引）----
#
# gitlink 那条要一个**存在的 commit sha**。原先无条件取私有仓的 HEAD：
#
#     inner=$(git -C 'Personal Memory' rev-parse HEAD)
#
# 私有仓不在时（干净 clone / CI 的常态）这两条 git 命令都会失败，
# `$inner` 变成空字符串 → `git mktree` 收到 `160000 commit \tPersonal Memory`
# —— 空 sha、坏输入 → 树没造出来 → `$c_gitlink` 也空 → 钩子看到全零 sha
# 就当成"新建分支"放行 → 断言报「期望 1，实际 0」。
#
# 表现很误导：**看起来像"钩子漏了 gitlink"（最该拦的那一种），
# 实际是测试自己没造出东西**。2026-09-20 在 WSL 的干净 clone 上跑出来的：
#
#     fatal: cannot change to 'Personal Memory': No such file or directory
#     fatal: input format error: 160000 commit 	Personal Memory
#
# 修法：私有仓在就用它的 HEAD，不在就用**本仓 HEAD** —— 钩子判的是
# "树里有没有一个叫 Personal Memory 的条目"，sha 指向哪个提交无关紧要。
# 这样测试在任何机器上都能造出**有效**的 gitlink。
if [ -d 'Personal Memory/.git' ]; then
  inner=$(git -C 'Personal Memory' rev-parse HEAD)
else
  inner=$(git rev-parse HEAD)
  echo "  · gitlink 用本仓 HEAD 代替（没有私有仓 —— 干净 clone / CI 的常态；那条断言测的是路径，不是这个 sha）"
fi

if [ -z "$inner" ]; then
  echo "  ✗ 内部错误：连本仓 HEAD 都取不到，测试无法构造 gitlink"
  exit 2
fi

tree_gitlink=$(printf '160000 commit %s\tPersonal Memory\n' "$inner" | git mktree)
c_gitlink=$(git commit-tree "$tree_gitlink" -m 'hook-test: gitlink')

env_blob=$(printf 'SECRET=1\n' | git hash-object -w --stdin)
tree_env=$(printf '100644 blob %s\t.env\n' "$env_blob" | git mktree)
c_env=$(git commit-tree "$tree_env" -m 'hook-test: env')

# 这里测的是**数据泄露那一道**。钩子后半段的"质量门"要跑全量自测，
# 而全量自测里又包含本测试（npm test → test:hooks）—— 不跳过就递归卡死。
# 所以显式设这个开关。**它是钩子文档里写明的**，不是偷偷绕过：
# 真实推送不会设它，实现在 .githooks/pre-push 的注释里。
SKIP_QUALITY_GATE=1
export SKIP_QUALITY_GATE

run() { # run <local_sha> → 退出码
  printf 'refs/heads/__t %s refs/heads/__t %s\n' "$1" "$Z" \
    | sh "$hook" origin "$public_url" >/dev/null 2>&1
  echo $?
}

# ---- 1. 干净状态 ----
chk "干净状态放行（含整条历史）" 0 "$(run "$(git rev-parse HEAD)")"

# ---- 2/3. 本该被拦的两种东西 ----
chk "拦住 gitlink 'Personal Memory'" 1 "$(run "$c_gitlink")"
chk "拦住 .env"                      1 "$(run "$c_env")"

# ---- 4. 证明 git 真的会调用它（不是"文件在那儿"而已）----
#
# 这一步的断言**改过两次**。
#
# 第一次（2026-09-19，外部审查指出）：
#
#   原来写的是 `chk "core.hooksPath 真的挂上了" 1 "$?"` —— 期望退出码是 1。
#   而 `git hook run` 在**钩子根本不存在**时也报 1：
#       error: cannot find a hook named pre-push   → exit 1
#   于是"保护生效"与"保护完全没装"的输出**逐字节相同**，两边都 ✓ 通过。
#   这是这个项目最怕的那种检查：在机制完全失效时照样绿。
#
# 第二次（2026-09-20，CI 第一次真跑）：
#
#   下面这两条在**干净 clone 上必然失败**，于是 CI 从第一次跑起就是红的。
#   根因是同一个东西的两面：`core.hooksPath` 是**本机 git 配置**，
#   clone 不会把它带过来 —— 干净机器上它必然是空的。
#   而"钩子没装"在那台机器上**是事实，不是缺陷**：CI 从不需要推送，
#   它也不该因为"我的开发机配置没跟过来"而变红。
#
#   于是按本仓自己的架构处理（见 contract.mjs 的 crossMachine / localOnly）：
#   **本机才成立的事实只打印、不参与判定。** 没装就说清"跳过了什么、
#   这台机器上什么没被验证"，而不是把"没装"报成"保护是假的"。
#
#   代价要说明白：**CI 不再验证 core.hooksPath 真的挂上了。**
#   那道验证只在本机跑（`npm test` 在装了钩子的机器上照旧验它）。
#   CI 里仍有下面 ①② 的前提检查与 ③④（造出泄露物看拦不拦得住），
#   但判据来自**直接执行钩子文件**，不依赖本机 git 配置。
hooks_path=$(git config core.hooksPath)

if [ -n "$hooks_path" ]; then
  # ①②③ 本机装了钩子：证明 git 真的会调用它
  stdin_file=$(mktemp)
  printf 'refs/heads/__t %s refs/heads/__t %s\n' "$c_gitlink" "$Z" > "$stdin_file"
  hook_out=$(git hook run --to-stdin="$stdin_file" pre-push -- origin "$public_url" 2>&1)
  hook_rc=$?
  rm -f "$stdin_file"

  case "$hook_out" in
    *"cannot find a hook"*)
      chk "git 找得到 pre-push 钩子（找不到就是没装）" "找到了" "找不到：$hook_out" ;;
    *)
      chk "git 找得到 pre-push 钩子（找不到就是没装）" "找到了" "找到了" ;;
  esac
  chk "钩子被调用后拦住了（退出码非 0）" "非0" "$([ "$hook_rc" != "0" ] && echo 非0 || echo 0)"
  chk "core.hooksPath 指向 .githooks" ".githooks" "$hooks_path"
else
  echo "  · 跳过「git 会不会真的调用它」3 项（core.hooksPath 没设 —— 干净 clone / CI 的常态）"
  echo "    这台机器上没被验证的是：钩子名解析、core.hooksPath 配置。"
  echo "    装法：git config core.hooksPath .githooks"
fi

# ---- 5. 私有仓的钩子（公开仓单独 clone 时不存在，跳过）----
private_hook='Personal Memory/.githooks/pre-push'
if [ -f "$private_hook" ]; then
  printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$Z" \
    | sh "$private_hook" origin "$private_url" >/dev/null 2>&1
  chk "私有仓钩子对私有远端放行" 0 "$?"

  printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$Z" \
    | sh "$private_hook" origin "$public_url" >/dev/null 2>&1
  chk "私有仓钩子拒绝公开仓" 1 "$?"
else
  echo "  · 跳过私有仓钩子（$private_hook 不存在 —— 单独 clone 公开仓时正常）"
fi

echo ""
if [ "$fail" = "0" ]; then
  echo "  全部通过（$total 项）"
else
  echo "  有失败项 —— 钩子的保护是假的"
fi
exit "$fail"
