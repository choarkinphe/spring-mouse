export function reconcilePagination(pagination, quotas, sortMode, totalPages) {
  const page = pagination.quotas !== quotas || pagination.sortMode !== sortMode
    ? 1
    : Math.min(pagination.page, totalPages);

  if (pagination.quotas === quotas && pagination.sortMode === sortMode && pagination.page === page) {
    return pagination;
  }

  return { quotas, sortMode, page };
}
