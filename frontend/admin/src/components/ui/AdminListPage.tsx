import { ReactNode } from 'react';
import { SectionHeader } from './SectionHeader';
import { Card, CardBody, CardHeader } from './Card';

// =============================================================================
// AdminListPage — shared layout primitive (v0.5.2).
// =============================================================================
//
// Standard vertical layout used by Packages, Backups, and GitHub / Releases:
//
//   1. Page header   (title + actions + status badges)
//   2. Standard card (naming standard / rules / reference)
//   3. Current-state card (primary state table)
//   4. Optional secondary current-state card
//   5. History tables (one or many)
//   6. Optional details slot (free-form trailing content)
//
// All slots except `header` are optional. Internal spacing is consistent so
// pages don't drift visually as they grow.

interface AdminListPageProps {
  header: {
    title: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
  };
  standardCard?: {
    title: ReactNode;
    subtitle?: ReactNode;
    body: ReactNode;
    right?: ReactNode;
  };
  currentStateCard?: {
    title: ReactNode;
    subtitle?: ReactNode;
    body: ReactNode;
    right?: ReactNode;
    flush?: boolean;
  };
  secondaryStateCard?: {
    title: ReactNode;
    subtitle?: ReactNode;
    body: ReactNode;
    right?: ReactNode;
    flush?: boolean;
  };
  historyTables?: Array<{
    title: ReactNode;
    subtitle?: ReactNode;
    body: ReactNode;
    right?: ReactNode;
    flush?: boolean;
  }>;
  detailsSlot?: ReactNode;
}

export function AdminListPage({
  header,
  standardCard,
  currentStateCard,
  secondaryStateCard,
  historyTables,
  detailsSlot
}: AdminListPageProps) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title={header.title}
        subtitle={header.subtitle}
        actions={header.actions}
      />

      {standardCard ? (
        <Card>
          <CardHeader
            title={standardCard.title}
            subtitle={standardCard.subtitle}
            right={standardCard.right}
          />
          <CardBody>{standardCard.body}</CardBody>
        </Card>
      ) : null}

      {currentStateCard ? (
        <Card>
          <CardHeader
            title={currentStateCard.title}
            subtitle={currentStateCard.subtitle}
            right={currentStateCard.right}
          />
          <CardBody className={currentStateCard.flush ? '!p-0' : undefined}>
            {currentStateCard.body}
          </CardBody>
        </Card>
      ) : null}

      {secondaryStateCard ? (
        <Card>
          <CardHeader
            title={secondaryStateCard.title}
            subtitle={secondaryStateCard.subtitle}
            right={secondaryStateCard.right}
          />
          <CardBody className={secondaryStateCard.flush ? '!p-0' : undefined}>
            {secondaryStateCard.body}
          </CardBody>
        </Card>
      ) : null}

      {historyTables?.map((h, i) => (
        <Card key={i}>
          <CardHeader title={h.title} subtitle={h.subtitle} right={h.right} />
          <CardBody className={h.flush ? '!p-0' : undefined}>{h.body}</CardBody>
        </Card>
      ))}

      {detailsSlot ?? null}
    </div>
  );
}
