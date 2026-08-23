export function shouldShowFirstRun(dataReady: boolean, machineCount: number): boolean {
  return dataReady && machineCount === 0;
}
