export function createResponseGate(timeoutMs?: number): {
  entered: Promise<void>; finished: Promise<void>;
  hold(): Promise<void>; release(): void; finish(): void;
};
