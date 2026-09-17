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

hook=.githooks/pre-push
public_url=git@github.com:cyancliff/cyancliff-assistant.git
private_url=git@github.com:cyancliff/personal-memory.git
Z=0000000000000000000000000000000000000000

fail=0
chk() { # chk 描述 期望 实际
  if [ "$2" = "$3" ]; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1（期望 $2，实际 $3）"
    fail=1
  fi
}

echo "公开仓 pre-push 钩子 · 突变测试"

# ---- 造测试用的树（纯 plumbing，不动工作区、不动索引）----
inner=$(git -C 'Personal Memory' rev-parse HEAD)
tree_gitlink=$(printf '160000 commit %s\tPersonal Memory\n' "$inner" | git mktree)
c_gitlink=$(git commit-tree "$tree_gitlink" -m 'hook-test: gitlink')

env_blob=$(printf 'SECRET=1\n' | git hash-object -w --stdin)
tree_env=$(printf '100644 blob %s\t.env\n' "$env_blob" | git mktree)
c_env=$(git commit-tree "$tree_env" -m 'hook-test: env')

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
stdin_file=$(mktemp)
printf 'refs/heads/__t %s refs/heads/__t %s\n' "$c_gitlink" "$Z" > "$stdin_file"
git hook run --to-stdin="$stdin_file" pre-push -- origin "$public_url" >/dev/null 2>&1
chk "core.hooksPath 真的挂上了" 1 "$?"
rm -f "$stdin_file"

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
  echo "  全部通过（5 项）"
else
  echo "  有失败项 —— 钩子的保护是假的"
fi
exit "$fail"
