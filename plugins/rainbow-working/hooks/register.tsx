import type { AgentStatus, EngineInterface, Register, Timer } from 'claude-code'

// 200ms（毎秒 5 回）: ui.render の再描画上限（毎秒 10 回）の半分に抑え、目で追える程度の流れにする
const TICK_MS = 200
// 1 tick で 12° ずらすと 30 tick = 6 秒で虹が 1 周する
const HUE_PER_TICK = 12
// 帯は 1 セル 4° で 90 セル ≒ 一般的なターミナル幅に虹 1 周が収まる
const BAND_HUE_PER_CELL = 4
// スピナーの語は 10 文字前後しかなく、帯と同じ 4° だとほぼ単色になるため大きく振る
const WORD_HUE_PER_CHAR = 30
// 色相を 15° 刻みに丸めて同色の連続セルを 1 つの Text にまとめ、要素数を列数の 1/4 程度に減らす
const HUE_QUANTUM = 15
const HUE_STEP_COUNT = 360 / HUE_QUANTUM
// 2 行目を左にずらし、斜めに流れる波に見せる
const SECOND_ROW_OFFSET_CELLS = 6
const GLYPH_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const ELLIPSIS = '…'
// turn.complete を取りこぼしても 15 秒以内に止める。$.agent.list() は軽いため短めにしている
const AGENT_CHECK_MS = 15_000
// waiting は自分の裏の作業や計画の承認を待っている状態で、エージェントとしてはまだ終わっていない
const ALIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting'])

// OKLCH の色相角を等間隔に回すと青の幅が狭く見えるため、基準色ごとに同じ幅を割り当てる。
// 赤・オレンジ・黄・緑・シアン・空色・青・藍・マゼンタの OKLCH 色相角
const HUE_ANCHORS_DEG = [29, 60, 105, 142, 195, 235, 264, 285, 328]

function rainbowHueDeg(cyclePosition: number): number {
  const scaled = cyclePosition * HUE_ANCHORS_DEG.length
  const index = Math.floor(scaled)
  const start = HUE_ANCHORS_DEG[index]!
  const next = HUE_ANCHORS_DEG[(index + 1) % HUE_ANCHORS_DEG.length]!
  const end = next > start ? next : next + 360

  return start + (end - start) * (scaled - index)
}

function hueDistanceDeg(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(diff, 360 - diff)
}

function srgbToHex(rgb: readonly number[]): string {
  return `#${rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
}

function linearToSrgb(value: number): number {
  // sRGB で表せない色は各チャンネルを切り詰める
  const clamped = Math.min(1, Math.max(0, value))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function hslToSrgb(hueDeg: number, lightness: number): readonly number[] {
  const chroma = 1 - Math.abs(2 * lightness - 1)
  const h = (((hueDeg % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] =
    h < 1 ? [chroma, x, 0]
    : h < 2 ? [x, chroma, 0]
    : h < 3 ? [0, chroma, x]
    : h < 4 ? [0, x, chroma]
    : h < 5 ? [x, 0, chroma]
    : [chroma, 0, x]
  const m = lightness - chroma / 2

  return [r + m, g + m, b + m]
}

// 係数は OKLab の定義 (Björn Ottosson) のもの
function srgbToOklchHueDeg(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  return (((Math.atan2(bAxis, a) * 180) / Math.PI) % 360 + 360) % 360
}

// 係数は OKLab の定義 (Björn Ottosson) のもの
function oklchToHex(lightness: number, chroma: number, hueDeg: number): string {
  const hueRad = (hueDeg * Math.PI) / 180
  const a = chroma * Math.cos(hueRad)
  const b = chroma * Math.sin(hueRad)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linearRgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return srgbToHex(linearRgb.map(linearToSrgb))
}

// 描画のたびに色を変換しないよう、15° 刻みの 24 色を読み込み時に作っておく
function buildOklchRainbowColors(lightness: number, chroma: number): readonly string[] {
  return Array.from({ length: HUE_STEP_COUNT }, (_, step) =>
    oklchToHex(lightness, chroma, rainbowHueDeg(step / HUE_STEP_COUNT)),
  )
}

// HSL の原色の中から、各段の OKLCH 色相に一番近いものを選ぶ。OKLCH で彩度を固定すると
// sRGB に収まる範囲に抑えられておとなしくなるため、色の並びだけ OKLCH に合わせて鮮やかさは HSL の原色を使う
function buildVividRainbowColors(hslLightness: number): readonly string[] {
  // 0.25° 刻み: 15° 刻みの 24 段に対して、隣の段と取り違えない程度に細かく、読み込み時の計算も軽い
  const searchStepDeg = 0.25
  const candidates = Array.from({ length: 360 / searchStepDeg }, (_, i) => {
    const rgb = hslToSrgb(i * searchStepDeg, hslLightness)
    return { rgb, oklchHueDeg: srgbToOklchHueDeg(rgb) }
  })

  return Array.from({ length: HUE_STEP_COUNT }, (_, step) => {
    const targetHueDeg = rainbowHueDeg(step / HUE_STEP_COUNT)
    const nearest = candidates.reduce((best, candidate) =>
      hueDistanceDeg(candidate.oklchHueDeg, targetHueDeg) < hueDistanceDeg(best.oklchHueDeg, targetHueDeg)
        ? candidate
        : best,
    )
    return srgbToHex(nearest.rgb)
  })
}

// 明度 0.55: 0.5 だと青・紫が暗い背景に沈むため少し持ち上げる
const VIVID_RAINBOW_COLORS = buildVividRainbowColors(0.55)
// 明度 0.70・彩度 0.15: 明度 0.75 では青が水色寄りに見えたため少し下げ、彩度を上げて鮮やかさを保つ
const SOFT_RAINBOW_COLORS = buildOklchRainbowColors(0.7, 0.15)

type BandStyle = { glyph: string; colors: readonly string[] }

const WORKING_BAND: BandStyle = { glyph: '█', colors: VIVID_RAINBOW_COLORS }
// 裏のエージェントだけの間は、網掛けの隙間から地の色を透かして暗く見せる。
// 明度を下げる方式は虹の色の差が潰れたため採らない
const BACKGROUND_BAND: BandStyle = { glyph: '░', colors: SOFT_RAINBOW_COLORS }

function quantizedHueStep(position: number, huePerPosition: number, tick: number): number {
  const hue = position * huePerPosition - tick * HUE_PER_TICK
  return Math.floor((((hue % 360) + 360) % 360) / HUE_QUANTUM)
}

type Run = { text: string; color: string }

function rainbowRuns(
  text: string,
  tick: number,
  huePerPosition: number,
  colors: readonly string[],
  positionOffset = 0,
): Run[] {
  const runs: Run[] = []
  let currentStep: number | undefined

  Array.from(text).forEach((char, i) => {
    const step = quantizedHueStep(i + positionOffset, huePerPosition, tick)
    const last = runs[runs.length - 1]

    if (last !== undefined && step === currentStep) {
      last.text += char
      return
    }

    currentStep = step
    runs.push({ text: char, color: colors[step]! })
  })

  return runs
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

type Animation = {
  tick: number
  ticker: Timer | undefined
  agentChecker: Timer | undefined
  isMainWorking: boolean
  agentTurnIds: Set<string>
  turnStartedAtMs: number
  nowMs: number
}

function hasAgentTurns(anim: Animation): boolean {
  return anim.agentTurnIds.size > 0
}

function stopAnimationIfIdle(anim: Animation): void {
  if (anim.isMainWorking || hasAgentTurns(anim)) {
    return
  }

  anim.ticker?.cancel()
  anim.ticker = undefined
  anim.agentChecker?.cancel()
  anim.agentChecker = undefined
}

// turn.complete を取りこぼしたエージェントのターンが残り続けないよう、一覧で裏付けを取る
async function dropAgentTurnsIfNoneAlive($: EngineInterface, anim: Animation): Promise<void> {
  if (!hasAgentTurns(anim)) {
    return
  }

  const agents = await $.agent.list()
  if (agents.some(agent => ALIVE_AGENT_STATUSES.has(agent.status))) {
    return
  }

  anim.agentTurnIds.clear()
  stopAnimationIfIdle(anim)
  $.ui.invalidate('ui.render')
}

function startAnimation($: EngineInterface, anim: Animation): void {
  if (anim.ticker !== undefined) {
    return
  }

  anim.ticker = $.clock.every(TICK_MS, () => {
    anim.tick += 1
    // 描画中の $ 呼び出しを避けるため、現在時刻はタイマー側で取っておく
    void $.clock.now().then(now => {
      anim.nowMs = now
      $.ui.invalidate('ui.render')
    })
  })
  anim.agentChecker = $.clock.every(AGENT_CHECK_MS, () => {
    void dropAgentTurnsIfNoneAlive($, anim)
  })
}

export const register: Register = on => {
  const anim: Animation = {
    tick: 0,
    ticker: undefined,
    agentChecker: undefined,
    isMainWorking: false,
    agentTurnIds: new Set(),
    turnStartedAtMs: 0,
    nowMs: 0,
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      anim.agentTurnIds.add(e.turnId)
      startAnimation($, anim)
      return next(e)
    }

    if (!anim.isMainWorking) {
      anim.turnStartedAtMs = await $.clock.now()
      anim.nowMs = anim.turnStartedAtMs
      anim.isMainWorking = true
    }
    startAnimation($, anim)

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) {
      anim.agentTurnIds.delete(e.turnId)
    } else {
      anim.isMainWorking = false
    }
    stopAnimationIfIdle(anim)
    // タイマーが止まると再描画が起きず、入力待ち中は暗い帯が残ってしまうため、最後に 1 回描き直す
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    // 中断などで turn.complete を取りこぼしても、入力待ちに戻った時点でメインの分は止める
    if (!e.props.isWorking) {
      anim.isMainWorking = false
      stopAnimationIfIdle(anim)
    }

    const isRunning = e.props.isWorking || hasAgentTurns(anim)
    const isHidden = e.surface !== 'terminal' || !isRunning || e.props.hasSurvey
    if (isHidden) {
      return next(e)
    }

    const band = e.props.isWorking ? WORKING_BAND : BACKGROUND_BAND
    const { Box, Text } = $.ui.resolve(e)
    const line = band.glyph.repeat(e.props.bodyColumns)
    const drawRow = (offset: number) => (
      <Text>
        {rainbowRuns(line, anim.tick, BAND_HUE_PER_CELL, band.colors, offset).map(run => (
          <Text color={run.color}>{run.text}</Text>
        ))}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {drawRow(0)}
        {drawRow(SECOND_ROW_OFFSET_CELLS)}
      </Box>
    )
  })

  // エンジンの行を子に埋め込む形は、語の空文字への書き換えが効かず語が二重に出たため、行全体を自前で描く
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const label = e.props.message ?? e.props.word
    const suffix = label.endsWith(ELLIPSIS) ? '' : e.props.suffix
    const glyph = GLYPH_FRAMES[anim.tick % GLYPH_FRAMES.length]
    const { Text } = $.ui.resolve(e)

    return (
      <Text>
        <Text color={VIVID_RAINBOW_COLORS[quantizedHueStep(0, 0, anim.tick)]}>{glyph} </Text>
        <Text bold>
          {rainbowRuns(`${label}${suffix}`, anim.tick, WORD_HUE_PER_CHAR, VIVID_RAINBOW_COLORS).map(run => (
            <Text color={run.color}>{run.text}</Text>
          ))}
        </Text>
        <Text dimColor> ({formatElapsed(anim.nowMs - anim.turnStartedAtMs)} · {e.props.mode})</Text>
      </Text>
    )
  })
}
