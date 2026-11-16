import type { Register, Timer } from 'claude-code'

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

function hueToHex(hueDeg: number): string {
  // 彩度 100%・明度 55%: 50% だと青・紫が暗い背景に沈むため少し持ち上げる
  const saturation = 1
  const lightness = 0.55
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

function rainbowRuns(text: string, tick: number, huePerPosition: number, positionOffset = 0): Run[] {
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
    runs.push({ text: char, color: hueToHex(hue) })
  })

  return runs
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

export const register: Register = on => {
  let tick = 0
  let ticker: Timer | undefined
  let turnStartedAtMs = 0
  let nowMs = 0

  const stopTicker = () => {
    ticker?.cancel()
    ticker = undefined
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && ticker === undefined) {
      turnStartedAtMs = await $.clock.now()
      nowMs = turnStartedAtMs
      ticker = $.clock.every(TICK_MS, () => {
        tick += 1
        // 描画中の $ 呼び出しを避けるため、現在時刻はタイマー側で取っておく
        void $.clock.now().then(now => {
          nowMs = now
          $.ui.invalidate('ui.render')
        })
      })
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      stopTicker()
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    // 中断などで turn.complete を取りこぼしても、入力待ちに戻った時点でタイマーを止める
    if (!e.props.isWorking) {
      stopTicker()
    }

    const isHidden =
      e.surface !== 'terminal' || !e.props.isWorking || e.props.hasSurvey
    if (isHidden) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const line = BLOCK.repeat(e.props.bodyColumns)
    const drawRow = (offset: number) => (
      <Text>
        {rainbowRuns(line, tick, BAND_HUE_PER_CELL, offset).map(run => (
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
    const glyph = GLYPH_FRAMES[tick % GLYPH_FRAMES.length]
    const { Text } = $.ui.resolve(e)

    return (
      <Text>
        <Text color={hueToHex(quantizedHue(0, 0, tick))}>{glyph} </Text>
        <Text bold>
          {rainbowRuns(`${label}${suffix}`, tick, WORD_HUE_PER_CHAR).map(run => (
            <Text color={run.color}>{run.text}</Text>
          ))}
        </Text>
        <Text dimColor> ({formatElapsed(nowMs - turnStartedAtMs)} · {e.props.mode})</Text>
      </Text>
    )
  })
}
