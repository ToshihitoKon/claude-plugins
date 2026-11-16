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
// 2 行目を左にずらし、斜めに流れる波に見せる
const SECOND_ROW_OFFSET_CELLS = 6
const BLOCK = '█'
const GLYPH_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const ELLIPSIS = '…'
// 明度 55%: 50% だと青・紫が暗い背景に沈むため少し持ち上げる
const WORKING_LIGHTNESS = 0.55
// 裏のエージェントだけが動いている間は暗くして、メインが入力待ちであることを見分けられるようにする。
// 0.3 では明るすぎて区別しにくかったため、サンプルを見比べて 0.13 にした
const BACKGROUND_LIGHTNESS = 0.13
// turn.complete を取りこぼしても 15 秒以内に止める。$.agent.list() は軽いため短めにしている
const AGENT_CHECK_MS = 15_000
// waiting は自分の裏の作業や計画の承認を待っている状態で、エージェントとしてはまだ終わっていない
const ALIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting'])

function hueToHex(hueDeg: number, lightness = WORKING_LIGHTNESS): string {
  const saturation = 1
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
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
  const toHex = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, '0')

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function quantizedHue(position: number, huePerPosition: number, tick: number): number {
  const hue = position * huePerPosition - tick * HUE_PER_TICK
  return Math.floor((((hue % 360) + 360) % 360) / HUE_QUANTUM) * HUE_QUANTUM
}

type Run = { text: string; color: string }

function rainbowRuns(
  text: string,
  tick: number,
  huePerPosition: number,
  positionOffset = 0,
  lightness = WORKING_LIGHTNESS,
): Run[] {
  const runs: Run[] = []
  let currentHue: number | undefined

  Array.from(text).forEach((char, i) => {
    const hue = quantizedHue(i + positionOffset, huePerPosition, tick)
    const last = runs[runs.length - 1]

    if (last !== undefined && hue === currentHue) {
      last.text += char
      return
    }

    currentHue = hue
    runs.push({ text: char, color: hueToHex(hue, lightness) })
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

    const lightness = e.props.isWorking ? WORKING_LIGHTNESS : BACKGROUND_LIGHTNESS
    const { Box, Text } = $.ui.resolve(e)
    const line = BLOCK.repeat(e.props.bodyColumns)
    const drawRow = (offset: number) => (
      <Text>
        {rainbowRuns(line, anim.tick, BAND_HUE_PER_CELL, offset, lightness).map(run => (
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
        <Text color={hueToHex(quantizedHue(0, 0, anim.tick))}>{glyph} </Text>
        <Text bold>
          {rainbowRuns(`${label}${suffix}`, anim.tick, WORD_HUE_PER_CHAR).map(run => (
            <Text color={run.color}>{run.text}</Text>
          ))}
        </Text>
        <Text dimColor> ({formatElapsed(anim.nowMs - anim.turnStartedAtMs)} · {e.props.mode})</Text>
      </Text>
    )
  })
}
