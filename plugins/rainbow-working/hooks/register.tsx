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

function linearToSrgb(value: number): number {
  // sRGB で表せない色は各チャンネルを切り詰める
  const clamped = Math.min(1, Math.max(0, value))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
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
  const toHex = (v: number) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')

  return `#${linearRgb.map(toHex).join('')}`
}

// 描画のたびに OKLCH を変換しないよう、15° 刻みの 24 色を読み込み時に作っておく
function buildRainbowColors(lightness: number, chroma: number): readonly string[] {
  return Array.from({ length: HUE_STEP_COUNT }, (_, step) =>
    oklchToHex(lightness, chroma, rainbowHueDeg(step / HUE_STEP_COUNT)),
  )
}

// 明度 0.70・彩度 0.15: 明度 0.75 では青が水色寄りに見えたため少し下げ、彩度を上げて鮮やかさを保つ
const RAINBOW_COLORS = buildRainbowColors(0.7, 0.15)
// 網掛けの隙間を埋める色。文字色の 2/3 ほどの明るさにして、粒が見える程度の差を残す
const RAINBOW_SHADE_COLORS = buildRainbowColors(0.47, 0.11)

type RainbowColors = { colors: readonly string[]; backgroundColors?: readonly string[] }
type BandStyle = RainbowColors & { glyph: string }

// 背景色を付けないと網掛けの隙間からターミナルの地の色が透けて暗くなるため、同系色で埋めて 2 色を重ねる
const WORKING_BAND: BandStyle = {
  glyph: '▓',
  colors: RAINBOW_COLORS,
  backgroundColors: RAINBOW_SHADE_COLORS,
}
// 裏のエージェントだけの間は、地の色を透かして暗く見せる。明度を下げる方式は虹の色の差が潰れたため採らない
const BACKGROUND_BAND: BandStyle = { glyph: '░', colors: RAINBOW_COLORS }
const SPINNER_COLORS: RainbowColors = { colors: RAINBOW_COLORS }

function quantizedHueStep(position: number, huePerPosition: number, tick: number): number {
  const hue = position * huePerPosition - tick * HUE_PER_TICK
  return Math.floor((((hue % 360) + 360) % 360) / HUE_QUANTUM)
}

type Run = { text: string; color: string; backgroundColor?: string }

function rainbowRuns(
  text: string,
  tick: number,
  huePerPosition: number,
  { colors, backgroundColors }: RainbowColors,
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
    runs.push({ text: char, color: colors[step]!, backgroundColor: backgroundColors?.[step] })
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
        {rainbowRuns(line, anim.tick, BAND_HUE_PER_CELL, band, offset).map(run => (
          <Text color={run.color} backgroundColor={run.backgroundColor}>{run.text}</Text>
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
        <Text color={RAINBOW_COLORS[quantizedHueStep(0, 0, anim.tick)]}>{glyph} </Text>
        <Text bold>
          {rainbowRuns(`${label}${suffix}`, anim.tick, WORD_HUE_PER_CHAR, SPINNER_COLORS).map(run => (
            <Text color={run.color}>{run.text}</Text>
          ))}
        </Text>
        <Text dimColor> ({formatElapsed(anim.nowMs - anim.turnStartedAtMs)} · {e.props.mode})</Text>
      </Text>
    )
  })
}
