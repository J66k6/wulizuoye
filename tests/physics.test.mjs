import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RotatingSystem,
  collisionSolution,
  linearMomentumMistake,
  predictRadiusChange,
  relError,
  gradePrediction,
  summarize,
  LAB_LIMITS,
} from '../assets/js/physics.js';

test('转动惯量随半径平方增大', () => {
  const sys = new RotatingSystem({ I0: 0.6, mass: 2, radius: 0.3, omega: 1 });
  assert.ok(Math.abs(sys.momentOfInertia - (0.6 + 2 * 2 * 0.09)) < 1e-12);
  sys.setRadius(0.6);
  assert.ok(Math.abs(sys.momentOfInertia - (0.6 + 2 * 2 * 0.36)) < 1e-12);
});

test('无外力矩时改变半径，角动量严格守恒', () => {
  const sys = new RotatingSystem({ radius: 0.6, omega: 1.2 });
  const L0 = sys.L;
  const omega0 = sys.omega;
  for (let r = 0.55; r >= 0.15; r -= 0.05) {
    sys.setRadius(r);
    assert.ok(Math.abs(sys.L - L0) < 1e-12, 'L 必须保持不变');
    assert.ok(sys.omega > omega0, '收臂后角速度应增大');
  }
  assert.ok(Math.abs(sys.L - L0) < 1e-12);
});

test('收臂过程中转动动能增加，增量等于理论值', () => {
  const sys = new RotatingSystem({ I0: 0.6, mass: 2, radius: 0.6, omega: 1.2 });
  const E0 = sys.energy;
  sys.setRadius(0.3);
  const expectedRatio = sys.L * sys.L / (2 * sys.momentOfInertia) / E0;
  assert.ok(expectedRatio > 1);
  assert.ok(Math.abs(sys.energy / E0 - expectedRatio) < 1e-12);
});

test('无 I0 时，半径减半使 ω 变为 4 倍', () => {
  const sys = new RotatingSystem({ I0: 0, mass: 1, radius: 0.5, omega: 1 });
  sys.setRadius(0.25);
  assert.ok(Math.abs(sys.omega - 4) < 1e-9);
});

test('开启摩擦后角动量单调衰减并最终停止', () => {
  const sys = new RotatingSystem({ radius: 0.5, omega: 1, friction: true });
  const L0 = sys.L;
  for (let i = 0; i < 500; i += 1) sys.step(0.05);
  assert.ok(sys.L < L0);
  assert.ok(sys.L >= 0);
  assert.ok(sys.frictionLoss > 0);
});

test('关闭摩擦时长时间演化不损失角动量', () => {
  const sys = new RotatingSystem({ radius: 0.5, omega: 1, friction: false });
  const L0 = sys.L;
  for (let i = 0; i < 2000; i += 1) sys.step(1 / 60);
  assert.ok(Math.abs(sys.L - L0) < 1e-12);
  assert.ok(Math.abs(sys.angle) > 0);
});

test('碰撞：绕支点角动量守恒，动能有损失', () => {
  const p = { M: 1, rodLength: 0.8, projectileMass: 0.02, speed: 300, offset: 0.3 };
  const sol = collisionSolution(p);
  const Irod = (p.M * p.rodLength ** 2) / 12;
  const I = Irod + p.projectileMass * p.offset ** 2;
  assert.ok(Math.abs(sol.inertia - I) < 1e-12);
  assert.ok(Math.abs(I * sol.omega - p.projectileMass * p.speed * p.offset) < 1e-9);
  assert.ok(sol.energyLoss > 0);
  assert.ok(sol.energyLossFraction > 0 && sol.energyLossFraction < 1);
  assert.equal(sol.direction, -1);
});

test('碰撞：击点越远，角动量与角速度越大', () => {
  const near = collisionSolution({ offset: 0.1 });
  const far = collisionSolution({ offset: 0.35 });
  assert.ok(far.angularMomentum > near.angularMomentum);
  assert.ok(far.omega > near.omega);
});

test('杆端支点的转动惯量为 ML²/3', () => {
  const sol = collisionSolution({ pivot: 'end', M: 2, rodLength: 1, projectileMass: 0.01 });
  assert.ok(Math.abs(sol.rodInertia - (2 / 3)) < 1e-12);
});

test('线动量守恒误区的对照值可复算', () => {
  const mistake = linearMomentumMistake({ M: 1, projectileMass: 0.02, speed: 300, offset: 0.3 });
  assert.ok(Math.abs(mistake.velocity - (0.02 * 300) / 1.02) < 1e-12);
  assert.ok(Math.abs(mistake.omegaIfLinear - mistake.velocity / 0.3) < 1e-12);
  assert.ok(mistake.omegaIfLinear < collisionSolution({ M: 1, projectileMass: 0.02, speed: 300, offset: 0.3 }).omega);
});

test('半径变化倍率预测与模型一致', () => {
  const p = predictRadiusChange({ I0: 0.6, mass: 2, r0: 0.6, r1: 0.3 });
  const sys = new RotatingSystem({ I0: 0.6, mass: 2, radius: 0.6, omega: 1.5 });
  const w0 = sys.omega;
  sys.setRadius(0.3);
  assert.ok(Math.abs(sys.omega / w0 - p.omegaRatio) < 1e-12);
});

test('相对误差与预测评分等级', () => {
  assert.equal(relError(10, 10), 0);
  assert.ok(Math.abs(relError(11, 10) - 10) < 1e-12);
  assert.equal(gradePrediction(10, 10).level, 'excellent');
  assert.equal(gradePrediction(20, 10).level, 'poor');
});

test('统计量', () => {
  const s = summarize([1, 2, 3]);
  assert.equal(s.n, 3);
  assert.equal(s.mean, 2);
  assert.ok(Math.abs(s.std - Math.sqrt(2 / 3)) < 1e-12);
});

test('半径限制在合法范围', () => {
  const sys = new RotatingSystem();
  sys.setRadius(99);
  assert.equal(sys.radius, LAB_LIMITS.R_MAX);
  sys.setRadius(-1);
  assert.equal(sys.radius, LAB_LIMITS.R_MIN);
});
