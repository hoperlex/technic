import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DownOutlined, UpOutlined } from '@ant-design/icons';

/**
 * Long comments and route contacts must remain available without making every feed row as tall as
 * its longest cell. The toggle overlays the edge so it does not add another line to the row.
 */
export function ExpandableCell({
  lines = 2,
  children,
}: {
  /** The collapsed row height matches the two-line cells alongside it. */
  lines?: number;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    // Expanded content has no clipping to measure. Preserve the last collapsed result so the
    // toggle remains available until the cell is collapsed and measured again.
    if (!el?.classList.contains('expandable-cell__body--clamped')) return;
    setClipped(el.scrollHeight - el.clientHeight > 1);
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // A clamped cell can change text without changing its size, so resize alone misses the new
    // overflow state. Keep both observers for the cell lifetime, independent of React children.
    const resizeObserver = new ResizeObserver(measure);
    const mutationObserver = new MutationObserver(measure);
    resizeObserver.observe(el);
    mutationObserver.observe(el, { subtree: true, characterData: true, childList: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [measure]);

  useLayoutEffect(() => {
    // The observer cannot detect a new clamp limit or the transition back from expanded content.
    if (!expanded) measure();
  }, [expanded, lines, measure]);

  return (
    <div className="expandable-cell">
      <div
        ref={bodyRef}
        className={`expandable-cell__body${expanded ? '' : ' expandable-cell__body--clamped'}`}
        style={expanded ? undefined : { WebkitLineClamp: lines }}
      >
        {children}
      </div>
      {clipped && (
        <button
          type="button"
          className="expandable-cell__toggle"
          aria-label={expanded ? 'Свернуть' : 'Показать полностью'}
          title={expanded ? 'Свернуть' : 'Показать полностью'}
          // The row click opens the record; this click must only reveal text in the same row.
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </button>
      )}
    </div>
  );
}
