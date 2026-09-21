import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, erc20Abi, parseUnits } from 'viem'
import { ADDR, routerAbi } from '../src/swap.js'
import { approveStep, parseAccount, swapStep, transferStep } from '../src/walletSign.js'

const me = '0x6A66533AF4e2EDD299A097310dF7f8e0935Fb510' as const
const nvda = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as const
const payee = '0xabc0000000000000000000000000000000000001' as const

test('approve step targets the token and approves exactly the router for the exact amount', () => {
  const s = approveStep(ADDR.usdg, ADDR.swapRouter02, parseUnits('2', 6), 'Approve USDG')
  assert.equal(s.to, ADDR.usdg)
  const d = decodeFunctionData({ abi: erc20Abi, data: s.data })
  assert.equal(d.functionName, 'approve')
  assert.equal((d.args?.[0] as string).toLowerCase(), ADDR.swapRouter02.toLowerCase())
  assert.equal(d.args?.[1], 2_000_000n)
})

test('swap step goes to the router, pays the output to the signer, and carries a minimum output', () => {
  const s = swapStep(ADDR.usdg, nvda, 500, me, 1_000_000n, 4_400_000_000_000_000n, 'Buy NVDA')
  assert.equal(s.to.toLowerCase(), ADDR.swapRouter02.toLowerCase())
  const d = decodeFunctionData({ abi: routerAbi, data: s.data })
  assert.equal(d.functionName, 'exactInputSingle')
  const p = d.args?.[0] as { tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint }
  assert.equal(p.recipient.toLowerCase(), me.toLowerCase())
  assert.equal(p.tokenIn.toLowerCase(), ADDR.usdg.toLowerCase())
  assert.equal(p.tokenOut.toLowerCase(), nvda.toLowerCase())
  assert.equal(p.fee, 500)
  assert.equal(p.amountIn, 1_000_000n)
  assert.equal(p.amountOutMinimum, 4_400_000_000_000_000n)
})

test('transfer step sends exactly the amount to the payee', () => {
  const s = transferStep(ADDR.usdg, payee, parseUnits('12.5', 6), 'Pay')
  const d = decodeFunctionData({ abi: erc20Abi, data: s.data })
  assert.equal(d.functionName, 'transfer')
  assert.equal((d.args?.[0] as string).toLowerCase(), payee)
  assert.equal(d.args?.[1], 12_500_000n)
})

test('parseAccount accepts real addresses and rejects everything else', () => {
  assert.equal(parseAccount(me.toLowerCase()), me)
  for (const bad of ['', '0x123', 'hello', null, undefined, 42, '0x' + 'z'.repeat(40)]) {
    assert.throws(() => parseAccount(bad), /valid wallet address/)
  }
})
