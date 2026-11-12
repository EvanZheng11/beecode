// 待办统计示例：过滤、完成率与优先级分组，仅使用 Node 内置能力
const assert = require('node:assert')

// 示例数据：done 表示该任务是否已完成
const 任务列表 = [
  { 标题: '整理周报', 优先级: '高', done: true },
  { 标题: '回复客户邮件', 优先级: '高', done: false },
  { 标题: '补充单元测试', 优先级: '中', done: false },
  { 标题: '更新依赖说明', 优先级: '低', done: true },
  { 标题: '归档旧分支', 优先级: '中', done: true },
]

// 统计总数、已完成数、完成率与各优先级分布
function 统计待办(任务) {
  const 总数 = 任务.length
  const 已完成 = 任务.filter((项) => 项.done).length
  const 完成率 = 总数 === 0 ? 0 : Math.round((已完成 / 总数) * 100)
  const 优先级分布 = {}
  for (const 项 of 任务) {
    优先级分布[项.优先级] = (优先级分布[项.优先级] ?? 0) + 1
  }
  return { 总数, 已完成, 完成率, 优先级分布 }
}

// 按完成状态拆分标题，保持原始顺序
function 拆分任务(任务) {
  const 已完成 = 任务.filter((项) => 项.done).map((项) => 项.标题)
  const 待完成 = 任务.filter((项) => !项.done).map((项) => 项.标题)
  return { 已完成, 待完成 }
}

const 统计结果 = 统计待办(任务列表)
const 拆分结果 = 拆分任务(任务列表)

console.log('待办统计示例')
console.log(`总数 ${统计结果.总数}，已完成 ${统计结果.已完成}`)
console.log(`完成率 ${统计结果.完成率}%`)
console.log(`优先级分布 ${JSON.stringify(统计结果.优先级分布)}`)
console.log(`已完成：${拆分结果.已完成.join('、')}`)
console.log(`待完成：${拆分结果.待完成.join('、')}`)
// 自检：正常数据的统计与拆分结果
assert.strictEqual(统计结果.总数, 5)
assert.strictEqual(统计结果.已完成, 3)
assert.strictEqual(统计结果.完成率, 60)
assert.deepStrictEqual(统计结果.优先级分布, { 高: 2, 中: 2, 低: 1 })
assert.deepStrictEqual(拆分结果.待完成, ['回复客户邮件', '补充单元测试'])
// 自检：空列表边界，完成率应为 0 而不是 NaN
const 空集 = 统计待办([])
assert.deepStrictEqual(空集, { 总数: 0, 已完成: 0, 完成率: 0, 优先级分布: {} })
console.log('自检通过：正常数据与空列表边界均符合预期')
