"use client";

import { Drawer } from "@/shared/components";

// Renders a registry `display.billingHelp` block: { title, updatedAt, sections: [{ heading, items?, table? }] }.
export default function ProviderBillingHelpDrawer({ help, isOpen, onClose }) {
  if (!help) return null;
  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={help.title || "计费规则"} width="lg">
      <div className="flex flex-col gap-5 text-sm">
        {help.updatedAt && (
          <p className="text-xs text-text-muted">资料更新于 {help.updatedAt}，以账号实时目录和额度卡片为准。</p>
        )}
        {(help.sections || []).map((section) => (
          <section key={section.heading} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text-main">{section.heading}</h3>
            {Array.isArray(section.items) && section.items.length > 0 && (
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-xs leading-relaxed text-text-muted">
                {section.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
            {section.table && (
              <div className="overflow-x-auto rounded-[10px] border border-border-subtle">
                <table className="w-full text-xs">
                  <thead className="bg-black/[0.03] dark:bg-white/[0.04]">
                    <tr>
                      {section.table.columns.map((col, i) => (
                        <th key={col} className={`px-3 py-2 font-medium text-text-muted ${i === 0 ? "text-left" : "text-right"}`}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.table.rows.map((row) => (
                      <tr key={row[0]} className="border-t border-border-subtle">
                        {row.map((cell, i) => (
                          <td key={i} className={`px-3 py-1.5 ${i === 0 ? "text-left font-mono text-text-main" : "text-right tabular-nums text-text-muted"}`}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
    </Drawer>
  );
}
