export type EntryStep = "input" | "review";
export interface EntryState { step: EntryStep; }
export type EntryAction = { type: "set-step"; step: EntryStep };
export function entryReducer(_state: EntryState, action: EntryAction): EntryState { return { step: action.step }; }
