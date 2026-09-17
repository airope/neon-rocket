export const BOOST_PAD_LAYOUT = (() => {
  const pads = [];
  const add = (x, z, amount = 12) => pads.push({
    id: `P${pads.length}`, x, z, amount,
    radius: amount === 100 ? 1.45 : 1.05,
    recharge: amount === 100 ? 10 : 4
  });
  for (const position of [[-41, 0], [41, 0], [-31, -30], [-31, 30], [31, -30], [31, 30]]) add(...position, 100);
  for (const z of [-20, 20]) for (const x of [-36, -18, 0, 18, 36]) add(x, z);
  for (const x of [-24, -8, 8, 24]) add(x, 0);
  return Object.freeze(pads.map(Object.freeze));
})();
