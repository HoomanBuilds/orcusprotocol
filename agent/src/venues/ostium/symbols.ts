const names: Readonly<Record<string, string>> = {
  CL: "WTI", HG: "XCU", SPX: "US500", NDX: "US100", DJI: "US30",
  DAX: "GER40", FTSE: "UK100", HSI: "HK50", NIK: "JP225",
};

export function ostiumSymbol(from: string, to: string): string {
  return `${names[from] ?? from}/${names[to] ?? to}`;
}
