export class StructuredModelOutputShapeError extends Error {
  constructor(readonly issues: readonly string[]) {
    super('STRUCTURED_MODEL_OUTPUT_INVALID');
    this.name = 'StructuredModelOutputShapeError';
  }
}

export async function parseStructuredModelOutput<T>(input: {
  content: string;
  parse: (content: string) => T;
  repair: (failure: { content: string; issues: readonly string[] }) => Promise<string>;
  invalidError?: () => Error;
}): Promise<T> {
  try {
    return input.parse(input.content);
  } catch (error) {
    if (!(error instanceof StructuredModelOutputShapeError)) throw error;
    const repaired = await input.repair({ content: input.content, issues: error.issues });
    try {
      return input.parse(repaired);
    } catch (repairError) {
      if (!(repairError instanceof StructuredModelOutputShapeError)) throw repairError;
      throw input.invalidError?.() ?? repairError;
    }
  }
}
