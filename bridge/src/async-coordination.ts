export class SingleFlightTask {
  private inFlight: Promise<unknown> | undefined;

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight as Promise<T>;
    const current = Promise.resolve().then(task);
    this.inFlight = current;
    const clear = () => {
      if (this.inFlight === current) this.inFlight = undefined;
    };
    void current.then(clear, clear);
    return current;
  }
}

export class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const current = this.tail.then(task, task);
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }
}
