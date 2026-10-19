// The latest push may belong to a manually generated summary, not the source item.
export const latestDelivery = (item: string) => `(SELECT x.id FROM deliveries x
  WHERE x.item_id=${item} OR x.item_id IN
    (SELECT output_item FROM summaries WHERE item_id=${item} AND output_item<>'')
  ORDER BY x.created DESC,x.rowid DESC LIMIT 1)`;
export const pushStateSql = `CASE
  WHEN COALESCE(p.status,d.status)='sent' THEN 'sent'
  WHEN COALESCE(p.resolution,d.resolution)='user_acknowledged' THEN 'unpublished'
  WHEN COALESCE(p.status,d.status)='sending' THEN 'sending'
  WHEN COALESCE(p.status,d.status) IN ('pending','retry_wait','digest_wait','batched') THEN 'waiting'
  WHEN COALESCE(p.status,d.status) IN ('failed','unknown') THEN 'attention'
  ELSE 'unpublished' END`;
