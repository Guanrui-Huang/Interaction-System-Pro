import type { AnalysisPlan } from './analysis-plan';

export type EvidencePolicy = 'knowledge' | 'data' | 'mixed';
export type ReportIntentKind = 'lookup' | 'trend' | 'diagnosis' | 'comparison' | 'knowledge' | 'identity' | 'recommendation';
export type ClarificationReason = 'ambiguous-subject' | 'ambiguous-period' | 'missing-evidence-scope';

export type PlannedQuestionIntent = {
  kind: ReportIntentKind;
  questionPart: string;
  evidencePolicy: EvidencePolicy;
};

export type ReportIntentPlan =
  | {
      kind: 'clarification';
      clarification: { prompt: string; reason: ClarificationReason; suggestions: string[] };
    }
  | {
      kind: 'report';
      intents: PlannedQuestionIntent[];
      knowledgeTopics: string[];
      assistantProfile: boolean;
      analysisPlan?: AnalysisPlan;
    };
