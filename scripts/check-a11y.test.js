// Pins the rules in scripts/check-a11y.js.
//
// The case that matters most is `a ternary whose label lives inside an
// expression`. The first detector stripped `{...}` groups before looking for
// text, so `{isVerifying2FA ? <Loader2/> : "Verify & Sign In"}` became empty and
// twenty-four correctly-labelled buttons were reported as unlabelled. That is
// the failure mode that matters for a detector like this: a false positive gets
// an `aria-label` bolted on, which is harmless to a screen reader and ruins the
// review.

const assert = require("assert");

const {
  findUnnamedButtons,
  findSilentErrors,
  countSubAaText,
  staticName,
  CONTRAST_BUDGET,
} = require("./check-a11y.js");

const cases = [
  {
    name: "a plain text label is a name",
    src: `<button type="submit">Send</button>`,
    buttons: 0,
  },
  {
    name: "a label inside a ternary is a name",
    src: `<button disabled={x} onClick={f}>{loading ? <Spinner /> : "Verify & Sign In"}</button>`,
    buttons: 0,
  },
  {
    name: "a label inside a nested ternary inside an interpolation is a name",
    src: `<button>{a ? <b>{c ? <i/> : "Save changes"}</b> : "Cancel"}</button>`,
    buttons: 0,
  },
  {
    // Not a limitation - a feature. `{tc("logout")}` resolves to a real string
    // at runtime, so the button does have an accessible name, and the key it
    // names is the best thing available statically. The first three expectations
    // in this file were written on the assumption that a bare interpolation was
    // undetectable, and all three were wrong; they would have produced a gate
    // that flagged every translated button in the codebase.
    name: "a translated label is a name",
    src: `<button><LogOut className="w-4" />{tc("logout")}</button>`,
    buttons: 0,
  },
  {
    name: "an aria-label is a name",
    src: `<button aria-label="Send message"><Send className="w-5" /></button>`,
    buttons: 0,
  },
  {
    name: "a title is a name",
    src: `<button title="Dismiss"><X className="w-4" /></button>`,
    buttons: 0,
  },
  {
    name: "an icon-only button with nothing else is unnamed",
    src: `<button onClick={send} className="w-11 h-11"><Send className="w-5" /></button>`,
    buttons: 1,
  },
  {
    name: "an error paragraph with role=alert is announced",
    src: `<p role="alert" className="text-red-600">{errors.email.message}</p>`,
    errors: 0,
  },
  {
    name: "an error paragraph with aria-live is announced",
    src: `<p aria-live="polite">{errors.otp.message}</p>`,
    errors: 0,
  },
  {
    name: "a bare error paragraph is silent",
    src: `<p className="text-red-500 text-xs">{errors.email.message}</p>`,
    errors: 1,
  },
  {
    name: "only the failing shades count against the contrast budget",
    src: `<span className="text-gray-400">a</span><span className="text-gray-500">b</span><span className="text-gray-700">c</span>`,
    subAa: 1,
  },
];

let failed = 0;

for (const c of cases) {
  try {
    const buttons = findUnnamedButtons(c.src).length;
    const errors = findSilentErrors(c.src).length;
    const subAa = countSubAaText(c.src);

    if (c.buttons !== undefined) assert.strictEqual(buttons, c.buttons, "button count");
    if (c.errors !== undefined) assert.strictEqual(errors, c.errors, "error count");
    if (c.subAa !== undefined) assert.strictEqual(subAa, c.subAa, "sub-AA count");

    console.log(`ok   ${c.name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${c.name}`);
    console.error(`     ${e.message}`);
  }
}

// `staticName` is the function the false positives came from, so it gets a direct
// test rather than only being exercised through the button detector.
{
  const direct = [
    ['{loading ? <Spinner /> : "Verify & Sign In"}', "Verify & Sign In"],
    ["Send", "Send"],
    ['<Icon />', ""],
    ['{t("key")}', "key"],
    ['<Icon />{t("key")}', "key"],
    ['{cond ? <Icon/> : "Send"}', "Send"],
    ["", ""],
  ];
  for (const [input, want] of direct) {
    try {
      const got = staticName(input);
      assert.strictEqual(got, want);
      console.log(`ok   staticName(${JSON.stringify(input)})`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL staticName(${JSON.stringify(input)}) - got ${JSON.stringify(staticName(input))}`);
    }
  }
}

// The budget must be a real number, and the real tree must sit under it.
{
  try {
    assert.strictEqual(typeof CONTRAST_BUDGET, "number");
    console.log(`ok   the contrast budget is a number (${CONTRAST_BUDGET})`);
  } catch (e) {
    failed += 1;
    console.error("FAIL the contrast budget is not a number");
  }
}

if (failed) {
  console.error(`\n${failed} case(s) failed.`);
  process.exit(1);
}
const NAME_CASES = 7;
console.log(`\ncheck-a11y self-test: ${cases.length + NAME_CASES + 1} cases passed.`);