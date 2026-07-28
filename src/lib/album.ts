import type { Sheet, SlotRef, Side } from "./types";

export const SLOTS_PER_SHEET = 4;

export const emptySheets = (n: number): Sheet[] =>
  Array.from({ length: n }, () => ({ front: [null, null], back: [null, null] }));

/** Canonical slot order for an album of `sheetCount` sheets. */
export function* iterateSlots(sheetCount: number): Generator<SlotRef> {
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    for (const side of ["front", "back"] as Side[]) {
      for (const pos of [0, 1] as (0 | 1)[]) {
        yield { sheet, side, pos };
      }
    }
  }
}

export const getSlot = (sheets: Sheet[], ref: SlotRef): string | null =>
  sheets[ref.sheet]?.[ref.side]?.[ref.pos] ?? null;

export const setSlot = (sheets: Sheet[], ref: SlotRef, uuid: string | null): Sheet[] => {
  const next = sheets.map((s) => ({ front: [...s.front], back: [...s.back] }));
  next[ref.sheet][ref.side][ref.pos] = uuid;
  return next;
};

export const swapSlots = (sheets: Sheet[], a: SlotRef, b: SlotRef): Sheet[] => {
  const va = getSlot(sheets, a);
  const vb = getSlot(sheets, b);
  return setSlot(setSlot(sheets, a, vb), b, va);
};

/** Fill `sheetCount` sheets chronologically from the chosen photos. */
export function autoFlow(sheetCount: number, chosenUuidsByDate: string[]): Sheet[] {
  const sheets = emptySheets(sheetCount);
  const slots = [...iterateSlots(sheetCount)];
  chosenUuidsByDate.slice(0, slots.length).forEach((uuid, i) => {
    const ref = slots[i];
    sheets[ref.sheet][ref.side][ref.pos] = uuid;
  });
  return sheets;
}

export const countPlaced = (sheets: Sheet[]): number => {
  let n = 0;
  for (const s of sheets) for (const side of ["front", "back"] as Side[]) for (const u of s[side]) if (u) n++;
  return n;
};

export const countSheetsUsed = (sheets: Sheet[]): number =>
  sheets.filter((s) => s.front.some(Boolean) || s.back.some(Boolean)).length;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Identifying file name: sheet-01-front-1--day03 */
export const slotName = (ref: SlotRef, dayIndex?: number): string => {
  const sideLabel = ref.side;
  const day = dayIndex ? `--day${pad2(dayIndex)}` : "";
  return `sheet-${pad2(ref.sheet + 1)}-${sideLabel}-${ref.pos + 1}${day}`;
};
