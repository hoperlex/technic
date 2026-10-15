export type RequestCreateReconciliation =
  { state: 'created'; requestId: string } | { state: 'not-created'; nextOperationId: string };
