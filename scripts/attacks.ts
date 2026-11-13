// The attack suite: each attack on the real wasm (local sandbox), with the refusal it must meet stated up front.
//   npm run attacks            all attacks, on res/postmoney.wasm
// scripts/mutants.ts runs the same suite on deliberately broken builds and expects each one to be caught.
import { pathToFileURL } from "node:url";
import { actions } from "near-api-js";
import { call, Checks, milli, NEAR, TGAS, usd, type Result } from "./lib/near.ts";
import { finish, postmoneyWasm, startWorld, wasm } from "./lib/world.ts";

export async function runAttacks(postmoney?: Buffer, quiet = false): Promise<{ c: Checks; secs: number }> {
  const c = new Checks(quiet);
  const t0 = Date.now();
  const w = await startWorld({ postmoney, rofrSecs: 5 });
  const { A, U, B, board, alice, bob, carol, dave, mallory, ada, root, chain } = w;
  const say = (s: string) => (quiet ? undefined : c.section(s));
  const ok = (r: Result, what: string) => {
    if (!r.ok) c.check(false, `setup: ${what}`, r.reason);
    return r;
  };
  const bal = w.usdcOf;
  const deadline = async (s: number) => String((await w.secs()) + s);
  const round = (name: string, o: Partial<{ cap: string | null; discount_bps: number; mfn: boolean; min: bigint; max: bigint; deadline: string }>) => ({
    terms: { name, safe: { cap: o.cap === undefined ? usd(5_000_000).toString() : o.cap, discount_bps: o.discount_bps ?? 0, mfn: o.mfn ?? false, pro_rata: false }, min_raise: (o.min ?? usd(10_000)).toString(), max_raise: (o.max ?? usd(100_000)).toString(), deadline: o.deadline! },
  });
  const far = await deadline(3600);
  try {
    say("Who may act");
    c.refused(await call(mallory, A, "open_round", round("Mallory's round", { deadline: far })), "only the board", "a stranger opens a round");
    ok(await w.boardCall("open_round", round("Seed", { deadline: far })), "open round 0");
    ok(await call(board, U, "mint", { amount: usd(1_000_000).toString() }), "the treasury holds USDC");
    c.refused(await call(mallory, A, "close_round", { round: 0 }), "only the board", "a stranger closes a round");
    c.refused(await call(mallory, A, "grant_options", { count: "1" }), "only the board", "a stranger grants options");
    c.refused(await call(mallory, A, "on_closed", { round: 0 }), "is private", "a stranger calls the close callback");

    say("Investing");
    const fakeTok = await w.deploy("fake", wasm("test_usdc.wasm"), "new", {});
    ok(await call(mallory, fakeTok.accountId, "mint", { amount: usd(100_000).toString() }, milli(2)), "mint fake");
    ok(await call(root, fakeTok.accountId, "storage_deposit", { account_id: A }, milli(2)), "register acme on fake");
    const fb = BigInt(await chain.view(fakeTok.accountId, "ft_balance_of", { account_id: mallory.accountId }));
    const fake = await w.pay(mallory, usd(50_000), { invest: 0 }, fakeTok.accountId);
    const fa = BigInt(await chain.view(fakeTok.accountId, "ft_balance_of", { account_id: mallory.accountId }));
    c.check(fa === fb && ((fake.reason ?? "").includes("unknown token") || !fake.ok), "invest in an unknown token: refused (\"unknown token\"), the token refunds every unit", `balance ${fb} -> ${fa}`);
    const b0 = await bal(alice.accountId);
    const s0 = BigInt(await w.view("storage_balance_of", { account_id: alice.accountId }));
    ok(await w.pay(alice, usd(150_000), { invest: 0 }), "alice invests");
    const s1 = BigInt(await w.view("storage_balance_of", { account_id: alice.accountId }));
    c.check(s1 < s0 && s0 - s1 < milli(10), "the investor pays for the bytes her investment adds (and her certificate's), from her own storage balance", `${Number(s0 - s1) / 1e21} milliNEAR`);
    c.check(b0 - (await bal(alice.accountId)) === usd(100_000), "invest over the max: the round keeps $100,000 of $150,000, the rest returns in the same call");
    const b1 = await bal(bob.accountId);
    const full = await w.pay(bob, usd(10_000), { invest: 0 });
    c.check((await bal(bob.accountId)) === b1 && (full.reason ?? "").includes("the round is full"), "invest in a full round: refused (\"the round is full\"), all of it refunded");
    const nost = await w.sub("nostorage");
    ok(await call(nost, U, "mint", { amount: usd(1000).toString() }, milli(2)), "mint");
    ok(await w.boardCall("open_round", round("Second", { deadline: far, max: usd(500_000) })), "open round 1");
    const b2 = await bal(nost.accountId);
    const ns = await w.pay(nost, usd(1000), { invest: 1 });
    c.check((await bal(nost.accountId)) === b2 && (ns.reason ?? "").includes("storage"), "invest without a storage balance: refused (\"storage: … needs … more storage balance\"), refunded", ns.logs.find((l) => l.includes("storage"))?.slice(0, 90));
    const badmsg = await w.pay(bob, usd(1000), { nonsense: 1 } as any);
    c.check((badmsg.reason ?? "").includes("exactly one") || (badmsg.reason ?? "").includes("msg must"), "a payment with a msg naming nothing: refused, refunded");
    c.refused(await call(mallory, A, "ft_on_transfer", { sender_id: mallory.accountId, amount: usd(1_000_000).toString(), msg: JSON.stringify({ invest: 1 }) }), "unknown token", "mallory calls ft_on_transfer herself to fake a deposit");

    say("Closing");
    ok(await w.boardCall("open_round", round("Big minimum", { deadline: far, min: usd(1_000_000), max: usd(2_000_000) })), "open round 2");
    ok(await w.pay(carol, usd(5_000), { invest: 2 }), "carol invests in round 2");
    c.refused(await w.boardCall("close_round", { round: 2 }), "has not met its minimum", "close a round below its minimum");
    ok(await w.boardCall("close_round", { round: 0 }), "close round 0");
    c.refused(await w.boardCall("close_round", { round: 0 }), "the round is not open", "close a round twice");
    const b3 = await bal(bob.accountId);
    const after = await w.pay(bob, usd(1000), { invest: 0 });
    c.check((await bal(bob.accountId)) === b3 && (after.reason ?? "").includes("the round is not open"), "invest after close: refused (\"the round is not open\"), refunded");

    say("Refunds");
    c.refused(await call(carol, A, "refund", { round: 2, investor: carol.accountId }), "refunds open only when", "refund from a round that is open and before its deadline");
    ok(await w.boardCall("cancel_round", { round: 2 }), "cancel round 2");
    const mb = await bal(mallory.accountId);
    const cb = await bal(carol.accountId);
    ok(await call(mallory, A, "refund", { round: 2, investor: carol.accountId }), "mallory triggers carol's refund");
    c.check((await bal(carol.accountId)) - cb === usd(5_000) && (await bal(mallory.accountId)) === mb, "claim another's refund: the money goes to carol, who paid; mallory gets nothing");
    c.refused(await call(carol, A, "refund", { round: 2, investor: carol.accountId }), "nothing to refund", "double refund");
    c.refused(await call(mallory, A, "refund", { round: 2, investor: mallory.accountId }), "nothing to refund", "refund to someone who never invested");
    const short = await deadline(4);
    ok(await w.boardCall("open_round", round("Short", { deadline: short, min: usd(50_000) })), "open round 3");
    ok(await w.pay(dave, usd(1_000), { invest: 3 }), "dave invests");
    await w.sleep(6_000);
    const late = await w.pay(dave, usd(1_000), { invest: 3 });
    c.check((late.reason ?? "").includes("deadline has passed"), "invest after the deadline: refused (\"the round's deadline has passed\")");
    c.refused(await w.boardCall("close_round", { round: 3 }), "has not met its minimum", "close an expired round below its minimum");
    const db = await bal(dave.accountId);
    ok(await call(mallory, A, "refund", { round: 3, investor: dave.accountId }), "anyone refunds an expired round");
    c.check((await bal(dave.accountId)) - db === usd(1_000), "a round that missed its minimum by the deadline: anyone triggers the refund, dave is paid back");

    say("SAFE certificates");
    const tok = (await w.view("nft_tokens_for_owner", { account_id: alice.accountId }))[0];
    c.check(tok?.token_id === "1", "alice holds SAFE #1", tok?.metadata?.title);
    c.refused(await call(alice, A, "nft_transfer", { receiver_id: mallory.accountId, token_id: "1" }, 1n), "board's consent", "move a SAFE with no board consent (outside the company's control)");
    c.refused(await call(mallory, A, "nft_transfer", { receiver_id: mallory.accountId, token_id: "1" }, 1n), "only the holder", "a stranger moves alice's SAFE");
    c.refused(await call(alice, A, "nft_transfer", { receiver_id: mallory.accountId, token_id: "1" }), "1 yoctoNEAR", "nft_transfer without the 1 yoctoNEAR (a function-call key can't do it)");
    c.refused(await call(alice, A, "nft_transfer_call", { receiver_id: mallory.accountId, token_id: "1", msg: "" }, 1n), "move only with nft_transfer", "nft_transfer_call");
    ok(await w.boardCall("consent_safe_transfer", { token_id: "1", receiver_id: dave.accountId }), "board consents to dave");
    c.refused(await call(alice, A, "nft_transfer", { receiver_id: mallory.accountId, token_id: "1" }, 1n), "board's consent", "consent for dave, transfer to mallory");
    c.refused(await call(alice, A, "adopt_mfn_terms", { token_id: "1", round: 1 }), "no MFN provision", "a non-MFN SAFE adopts later terms");

    say("MFN");
    ok(await w.boardCall("open_round", round("MFN", { deadline: far, cap: null, mfn: true })), "open round 4 (MFN, uncapped)");
    ok(await w.pay(bob, usd(20_000), { invest: 4 }), "bob invests in the MFN round");
    ok(await w.boardCall("close_round", { round: 4 }), "close round 4");
    const mfn = (await w.view("nft_tokens_for_owner", { account_id: bob.accountId })).find((t: any) => JSON.parse(t.metadata.extra).mfn);
    c.refused(await call(bob, A, "adopt_mfn_terms", { token_id: mfn.token_id, round: 0 }), "issued later", "an MFN holder adopts an earlier round's terms");
    c.refused(await call(mallory, A, "adopt_mfn_terms", { token_id: mfn.token_id, round: 1 }), "only the holder", "a stranger amends bob's MFN SAFE");
    ok(await w.boardCall("open_round", round("Later, better", { deadline: far, cap: usd(6_000_000).toString(), discount_bps: 1000 })), "open round 5 ($6m cap, 10% discount)");
    const adopt = await call(bob, A, "adopt_mfn_terms", { token_id: mfn.token_id, round: 5 });
    const amended = await w.view("nft_token", { token_id: mfn.token_id });
    c.check(adopt.ok && JSON.parse(amended.metadata.extra).cap === usd(6_000_000).toString() && JSON.parse(amended.metadata.extra).amended_from_round === 4, "the MFN holder adopts a later round's terms: its certificate now reads $6m cap, 10% discount", amended.metadata.title);

    say("The priced round");
    const terms = { name: "Series A", pre_money: usd(20_000_000).toString(), investors: [{ account: carol.accountId, cash: usd(5_000_000).toString() }], pool: { target_bps: 1000 }, price_decimals: 4 };
    const p = await w.view("preview_priced_round", { terms });
    c.refused(await call(mallory, A, "execute_priced_round", { terms, expected_hash: p.state_hash }, 0n, 250n), "only the board", "a stranger executes the priced round");
    c.refused(await w.boardCall("execute_priced_round", { terms, expected_hash: "00".repeat(32) }), "changed since the preview", "execute with a made-up hash");
    c.refused(await w.boardCall("execute_priced_round", { terms: { ...terms, pre_money: usd(25_000_000).toString() }, expected_hash: p.state_hash }), "changed since the preview", "execute other terms than the previewed ones under the previewed hash");
    ok(await call(alice, A, "nft_transfer", { receiver_id: dave.accountId, token_id: "1" }, 1n), "alice moves SAFE #1 to dave with the board's consent");
    c.refused(await w.boardCall("execute_priced_round", { terms, expected_hash: p.state_hash }), "changed since the preview", "a SAFE changed hands after the preview: the old hash is refused");
    const p2 = await w.view("preview_priced_round", { terms });
    const ex = await w.boardCall("execute_priced_round", { terms, expected_hash: p2.state_hash });
    c.check(ex.ok && (await w.view("nft_total_supply")) === "0", "execute with the fresh hash: every SAFE converts, every certificate is burned", ex.reason);
    c.refused(await w.boardCall("execute_priced_round", { terms, expected_hash: p2.state_hash }), "changed since the preview", "convert twice (replay the executed proposal)");
    const t = await w.view("cap_table");
    const pool = BigInt(t.pool);
    const fd = t.positions.reduce((a: bigint, x: any) => a + BigInt(x.shares), 0n) + BigInt(t.options) + pool;
    c.check(pool * 10_000n >= 1000n * fd && (pool - 1n) * 10_000n < 1000n * (fd - 1n), "the pool is the least whole number of shares that is 10% of the post-money", `${pool} of ${fd}`);

    say("Secondary sales and the right of first refusal");
    const o = await call(ada, A, "offer_shares", { class: 0, shares: "1000000", price: usd(500_000).toString(), buyer: dave.accountId });
    ok(o, "ada offers 1,000,000 common to dave");
    c.refused(await call(ada, A, "offer_shares", { class: 0, shares: "5500000", price: usd(1).toString(), buyer: mallory.accountId }), "unlocked shares", "sell the same shares twice (offer more than the unlocked balance)");
    c.refused(await call(mallory, A, "offer_shares", { class: 0, shares: "1", price: "1", buyer: dave.accountId }), "no shares of this class", "offer shares you don't hold");
    const wrong = await w.pay(mallory, usd(500_000), { buy: o.value });
    c.check((wrong.reason ?? "").includes("to someone else"), "the wrong buyer pays: refused (\"this offer is to someone else\"), refunded");
    const under = await w.pay(dave, usd(100), { buy: o.value });
    c.check((under.reason ?? "").includes("full price"), "the buyer underpays: refused, refunded");
    ok(await w.pay(dave, usd(500_000), { buy: o.value }), "dave pays the price into escrow");
    c.refused(await call(ada, A, "cancel_offer", { offer: o.value }), "the buyer has paid", "the seller backs out after the buyer paid");
    c.refused(await call(dave, A, "settle_offer", { offer: o.value }), "right of first refusal is still open", "front-run the company's right of first refusal (settle inside the window)");
    const mrofr = await w.pay(mallory, usd(500_000), { rofr: o.value });
    c.check((mrofr.reason ?? "").includes("only the company's treasury"), "a stranger 'exercises' the company's ROFR: refused, refunded");
    await w.sleep(6_500);
    const late2 = await call(board, U, "ft_transfer_call", { receiver_id: A, amount: usd(500_000).toString(), msg: JSON.stringify({ rofr: o.value }) }, 1n, 150n);
    c.check((late2.reason ?? "").includes("window has closed"), "the company matches after its window closed: refused, refunded");
    const ab = await bal(ada.accountId);
    ok(await call(mallory, A, "settle_offer", { offer: o.value }), "settle");
    c.check((await bal(ada.accountId)) - ab === usd(500_000), "after the window, the trade settles: ada is paid");
    c.refused(await call(mallory, A, "settle_offer", { offer: o.value }), "already settled", "settle twice");

    say("Rollback when a payout fails");
    // A second company whose treasury, and one founder, never registered with the token: their transfers fail.
    const ghost = await w.sub("ghost");
    const nobody = await w.sub("nobody");
    const acme2 = await w.sub("acme2");
    await acme2.signAndSendTransaction({
      receiverId: acme2.accountId,
      actions: [actions.deployContract(postmoney ?? postmoneyWasm()), actions.functionCall("new", { owner_id: B, company: "Acme 2", usdc: U, treasury: nobody.accountId, founders: [{ account: ghost.accountId, shares: "1000000" }], options: "0", pool: "0", rofr_secs: "1" }, 100n * TGAS, 0n)],
      waitUntil: "FINAL",
    });
    const A2 = acme2.accountId;
    ok(await call(root, U, "storage_deposit", { account_id: A2 }, milli(2)), "register acme2");
    ok(await call(root, A2, "storage_deposit", { account_id: B }, NEAR / 4n), "board storage on acme2");
    ok(await call(ghost, A2, "storage_deposit", {}, milli(50)), "ghost storage");
    ok(await call(alice, A2, "storage_deposit", {}, milli(50)), "alice storage on acme2");
    ok(await call(board, A2, "open_round", round("Seed", { deadline: far })), "open acme2 round");
    ok(await call(alice, U, "ft_transfer_call", { receiver_id: A2, amount: usd(20_000).toString(), msg: JSON.stringify({ invest: 0 }) }, 1n, 150n), "alice invests in acme2");
    const close = await call(board, A2, "close_round", { round: 0 }, 0n, 200n);
    const r2 = (await chain.view<any[]>(A2, "rounds"))[0];
    c.check(r2.status === "Open" && BigInt(await chain.view(U, "ft_balance_of", { account_id: A2 })) === usd(20_000) && (await chain.view(A2, "nft_total_supply")) === "0", "the payout to the treasury fails: the round is open again, the $20,000 still in escrow, no certificate minted", `close tx ok=${close.ok}, round ${r2.status}`);
    const o2 = await call(ghost, A2, "offer_shares", { class: 0, shares: "1000", price: usd(1_000).toString(), buyer: dave.accountId });
    ok(o2, "ghost offers shares");
    ok(await call(dave, U, "ft_transfer_call", { receiver_id: A2, amount: usd(1_000).toString(), msg: JSON.stringify({ buy: o2.value }) }, 1n, 150n), "dave pays");
    await w.sleep(2_500);
    await call(mallory, A2, "settle_offer", { offer: o2.value }, 0n, 150n);
    const t2 = await chain.view<any>(A2, "cap_table");
    const off = (await chain.view<any[]>(A2, "offers"))[0];
    c.check(off.status === "Funded" && t2.positions.length === 1 && t2.positions[0].shares === "1000000" && t2.positions[0].locked === "1000", "the payout to the seller fails: the shares go back to the seller (still locked), the offer is paid and can settle again", `${off.status}, ${JSON.stringify(t2.positions.map((x: any) => [x.holder.split(".")[0], x.shares, x.locked]))}`);
  } catch (e) {
    c.check(false, "the suite ran to the end", String((e as Error)?.stack ?? e).slice(0, 300));
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  await Promise.race([w.stop(), w.sleep(15_000)]);
  return { c, secs };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { c, secs } = await runAttacks();
  await finish(c, `attacks refused as expected (${secs} s)`);
}
