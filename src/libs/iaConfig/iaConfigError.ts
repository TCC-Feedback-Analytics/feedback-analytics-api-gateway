/** Erros seguros: nunca transportar o body upstream, a chave ou dados cifrados. */
export class IaConfigError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly transient = false,
  ) {
    super(code);
    this.name = 'IaConfigError';
  }
}
