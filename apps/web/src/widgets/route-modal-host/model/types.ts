import type { ReactNode } from 'react';

export interface RequestCardRenderProps {
  requestId: string;
  onClose: () => void;
}

export interface RouteModalHostProps {
  children: ReactNode;
  renderRequestCard: (props: RequestCardRenderProps) => ReactNode;
}
