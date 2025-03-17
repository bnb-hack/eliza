import BigNumber from "bignumber.js";

export function toBN(value: any): BigNumber {
  return new BigNumber(value || 0);
}
