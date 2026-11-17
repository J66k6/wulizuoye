import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAdaptiveQuiz,
  defaultMastery,
  gradeItem,
  updateMastery,
  summarizeQuiz,
  CONCEPT_KEYS,
} from '../assets/js/quiz.js';
import { evaluateText, TutorEngine } from '../assets/js/ai.js';

function tutorContext() {
  return {
    view: 'lab',
    lab: {
      I0: 0.6,
      mass: 2,
      radius: 0.6,
      inertia: 2.04,
      omega: 1.2,
      L: 2.448,
      Lref: 2.448,
      deltaL: 0,
      energy: 1.47,
      friction: false,
    },
    data: [],
    tasks: {},
    collision: {},
    quiz: { completed: false, score: null, weak: [], mastery: defaultMastery() },
    reflection: { text: '', score: null },
    name: '',
  };
}

test('自适应选题返回 8 道唯一题目并覆盖至少 4 个概念', () => {
  const items = selectAdaptiveQuiz(defaultMastery(), 8, 20261117);
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map((item) => item.id)).size, 8);
  const concepts = new Set(items.flatMap((item) => item.concepts));
  assert.ok(concepts.size >= 4, `概念覆盖不足: ${[...concepts].join(',')}`);
  assert.ok(items[0].concepts.includes('definition'));
  for (const item of items) {
    assert.ok(item.concepts.every((key) => CONCEPT_KEYS.includes(key)));
    if (item.type === 'mcq') {
      assert.ok(item.answerIndex >= 0 && item.answerIndex < item.options.length);
    } else {
      assert.ok(Number.isFinite(item.answer));
    }
  }
});

test('同一随机种子生成相同题池', () => {
  const a = selectAdaptiveQuiz(defaultMastery(), 8, 42);
  const b = selectAdaptiveQuiz(defaultMastery(), 8, 42);
  assert.deepEqual(a.map((item) => item.id), b.map((item) => item.id));
});

test('单选题判分与干扰项解释', () => {
  const items = selectAdaptiveQuiz(defaultMastery(), 8, 7);
  const item = items.find((entry) => entry.type === 'mcq');
  assert.ok(item);
  const right = gradeItem(item, { option: item.answerIndex });
  assert.equal(right.correct, true);
  const wrongIndex = (item.answerIndex + 1) % item.options.length;
  const wrong = gradeItem(item, { option: wrongIndex });
  assert.equal(wrong.correct, false);
  assert.ok(wrong.body.length > 10);
});

test('数值题容差判分', () => {
  const item = {
    type: 'numeric',
    answer: 10,
    tolerance: 0.03,
    solution: '10',
    hint: '公式',
    explanation: '10',
  };
  assert.equal(gradeItem(item, { value: 10.2 }).correct, true);
  assert.equal(gradeItem(item, { value: 11 }).correct, false);
  assert.equal(gradeItem(item, { value: Number.NaN }).correct, false);
});

test('掌握度随答题更新', () => {
  const mastery = defaultMastery();
  const up = updateMastery(mastery, ['definition'], true, 2);
  assert.ok(up.definition > mastery.definition);
  const down = updateMastery(mastery, ['definition'], false, 2);
  assert.ok(down.definition < mastery.definition);
  assert.ok(down.definition >= 0.05);
});

test('测评汇总正确率与薄弱概念', () => {
  const items = [
    { id: 'a', concepts: ['definition'], stem: 'A' },
    { id: 'b', concepts: ['collision'], stem: 'B' },
    { id: 'c', concepts: ['collision'], stem: 'C' },
  ];
  const answers = [
    { correct: true },
    { correct: false },
    { correct: false },
  ];
  const summary = summarizeQuiz(items, answers);
  assert.equal(summary.correctCount, 1);
  assert.equal(summary.total, 3);
  assert.equal(summary.score, 33);
  assert.ok(summary.weak.includes('collision'));
});

test('任务 3 量规：完整因果链得 100', () => {
  const result = evaluateText(
    '收臂时转轴方向合外力矩为零，所以角动量守恒。半径减小使转动惯量减小，由ω=L/I可知角速度增大。动能的增加来自人体拉配重向内做的功，不是无中生有。',
    'task3'
  );
  assert.equal(result.score, 100);
  assert.equal(result.missing.length, 0);
});

test('任务 5 量规：覆盖碰撞三个要点', () => {
  const result = evaluateText(
    '碰撞瞬间支点冲力对支点的力矩为零，所以绕支点角动量守恒，mvd=Iω。但支点冲力使系统线动量不守恒；子弹嵌入杆是完全非弹性碰撞，机械能损失为内能和热。',
    'task5'
  );
  assert.equal(result.score, 100);
});

test('学习反思量规：识别缺失项', () => {
  const good = evaluateText(
    '收臂过程中，转轴方向合外力矩为零，因此角动量守恒；半径减小使转动惯量减小，角速度增大；动能增加来自人收臂时做的功。实验数据中 L 的偏差约为 1%，在误差范围内。',
    'reflection'
  );
  assert.equal(good.score, 100);
  const poor = evaluateText('我觉得转动变快了，因为半径变小。', 'reflection');
  assert.ok(poor.score < 60);
  assert.ok(poor.missing.length > 0);
});

test('TutorEngine 能纠正“角速度守恒”迷思且不依赖 DOM', () => {
  const engine = new TutorEngine();
  const reply = engine.localAnswer('角速度守恒吗？', tutorContext());
  assert.match(reply.text, /角动量/);
  assert.match(reply.text, /ω/);
});

test('TutorEngine 的下一步建议读取任务状态', () => {
  const engine = new TutorEngine();
  const ctx = tutorContext();
  ctx.data = [{ L: 2.4 }];
  const reply = engine.localAnswer('下一步做什么？', ctx);
  assert.match(reply.text, /任务|数据|测评/);
});
