import type { ContractTypes } from './generated/types.js';
import { generatedValidators } from './generated/validators.js';
import type { RuntimeContractIssue, RuntimeContractValidator } from './generated/validators.runtime.js';

export type ContractName = keyof ContractTypes;

export class ContractValidationError extends TypeError {
  readonly contract: ContractName;
  readonly issues: readonly RuntimeContractIssue[];

  constructor(contract: ContractName, issues: readonly RuntimeContractIssue[]) {
    super(`Invalid Atlas contract: ${contract}`);
    this.name = 'ContractValidationError';
    this.contract = contract;
    this.issues = issues;
  }
}

const validators: Record<ContractName, RuntimeContractValidator> = generatedValidators;

export function validateContract<K extends ContractName>(name: K, value: unknown): value is ContractTypes[K] {
  return validators[name](value) as boolean;
}

export function assertContract<K extends ContractName>(name: K, value: unknown): asserts value is ContractTypes[K] {
  const validator = validators[name];
  if (!validator(value)) throw new ContractValidationError(name, validator.errors ?? []);
}
