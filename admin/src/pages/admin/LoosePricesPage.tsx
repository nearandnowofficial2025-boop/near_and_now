import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { getAdminToken } from '../../services/adminSession';
import { getCurrentAdmin } from '../../services/secureAdminAuth';
import { hasPermission } from '../../services/adminAuthService';
import { useToast } from '../../context/ToastContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CardBody,
  FormField,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  StatCard,
  StatGrid,
  Table,
  TableContainer,
  TableEmptyRow,
  TableSkeletonRows,
  Tabs,
  TBody,
  Td,
  Th,
  THead,
  Toggle,
  Tr,
  useConfirm,
} from '../../components/ui';
import { formatCurrency, formatTime } from '../../utils/format';
import {
  PINCODE_RE,
  clockLabel,
  clockMinutes,
  effectivePrice,
  parseAdminPrice,
  regionItemRows,
  sheetStatusLabel,
  type LooseItem,
  type LooseOverview,
  type LooseSettings,
  type LooseStore,
} from '../../utils/loosePrices';

const API_BASE = import.meta.env.VITE_API_URL || '';

async function call<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET', body?: unknown): Promise<T> {
  const token = getAdminToken() || '';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
  return json as T;
}
const errorMessage = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

type Tab = 'prices' | 'shops' | 'regions' | 'settings';
type Day = 'today' | 'tomorrow';
type RegionsResponse = { today: string; tomorrow: string; regions: Array<{ id: string; name: string; pincodes: string[]; pincodes_from_tomorrow: string[] }> };

/** India's date today plus `days` (UTC+5:30, no daylight saving). */
const istDate = (days: number) => new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);

/** Minutes since midnight in India now (UTC+5:30, no daylight saving). */
const istMinutesNow = () => {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/**
 * Daily loose prices (2026-11-17). Shops set tomorrow's per-kg price for each
 * loose item until the cut-off; at the cut-off each region's price is the
 * highest of its shops' prices, ignoring any far above the middle price
 * (flagged here). Admin can set any region's price for today or tomorrow at
 * any time (it wins for that day), correct or remove a shop's price, reopen a
 * shop's sheet, leave a shop out of the calculation, and manage regions.
 */
const LoosePricesPage = () => {
  const confirm = useConfirm();
  const { showToast } = useToast();
  const admin = getCurrentAdmin();
  const canEdit = Boolean(admin && hasPermission(admin, 'products.edit'));
  const canEditStores = Boolean(admin && hasPermission(admin, 'store_verification.edit'));

  const [tab, setTab] = useState<Tab>('prices');
  const [day, setDay] = useState<Day>('tomorrow');
  const [ov, setOv] = useState<LooseOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regionId, setRegionId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [correcting, setCorrecting] = useState<{ store: LooseStore; item: LooseItem; price: number | null } | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (which: Day) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      // One request: the day's date is worked out in India time here.
      const date = which === 'today' ? istDate(0) : istDate(1);
      const data = await call<LooseOverview & { success: boolean }>(`/api/admin/loose-prices?date=${date}`);
      if (id !== reqId.current) return;
      setOv(data);
      setRegionId((cur) => cur || data.regions.find((r) => data.stores.some((s) => s.region_id === r.id))?.id || data.regions[0]?.id || '');
    } catch (err) {
      if (id === reqId.current) setError(errorMessage(err, 'Could not load loose prices'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(day); }, [day, load]);

  const rows = useMemo(() => (ov && regionId ? regionItemRows(ov, regionId, search) : []), [ov, regionId, search]);
  const regionName = (id: string | null) => ov?.regions.find((r) => r.id === id)?.name ?? 'No region';
  const flaggedTotal = ov?.flags.length ?? 0;
  const pastCutoff = ov ? istMinutesNow() >= clockMinutes(ov.settings.cutoff_time) : false;
  const submittedCount = ov ? ov.stores.filter((s) => s.submitted_at).length : 0;

  const setRegionPrice = async (item: LooseItem, price: number | null) => {
    if (!ov) return;
    setBusy(`price:${item.id}`);
    try {
      await call('/api/admin/loose-prices/region-price', 'PUT', { region_id: regionId, master_product_id: item.id, date: ov.date, price });
      showToast(price == null ? `${item.name}: admin price cleared` : `${item.name}: ₹${price}/kg in ${regionName(regionId)} for ${day}`, 'success');
      setDrafts((d) => ({ ...d, [item.id]: '' }));
      await load(day);
    } catch (err) {
      showToast(errorMessage(err, 'Could not change the price'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const submitDraft = (item: LooseItem) => {
    const parsed = parseAdminPrice(drafts[item.id] ?? '', item.mrp);
    if ('error' in parsed) return showToast(parsed.error, 'error');
    void setRegionPrice(item, parsed.price);
  };

  const correctShopPrice = async (price: number | null) => {
    if (!ov || !correcting) return;
    setBusy('correct');
    try {
      await call('/api/admin/loose-prices/shop-price', 'PUT', {
        store_id: correcting.store.id, master_product_id: correcting.item.id, date: ov.date, price,
      });
      showToast(price == null ? `${correcting.store.name}'s price removed` : `${correcting.store.name}'s price corrected to ₹${price}`, 'success');
      setCorrecting(null);
      await load(day);
    } catch (err) {
      showToast(errorMessage(err, "Could not change the shop's price"), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loose prices"
        description={ov
          ? `Shops set tomorrow's prices until ${clockLabel(ov.settings.cutoff_time)}; they're told at ${clockLabel(ov.settings.notify_time)} and the prices go live at midnight.`
          : 'Daily loose prices set by shops, per region.'}
        actions={<Button variant="secondary" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={() => void load(day)} loading={loading}>Refresh</Button>}
      >
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          aria-label="Loose prices sections"
          items={[
            { value: 'prices', label: 'Prices', count: flaggedTotal || undefined },
            { value: 'shops', label: 'Shops' },
            { value: 'regions', label: 'Regions' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
      </PageHeader>

      {error && <Alert tone="danger" title="Couldn't load loose prices" actions={<Button size="sm" onClick={() => void load(day)}>Retry</Button>}>{error}</Alert>}

      {(tab === 'prices' || tab === 'shops') && (
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<Day>
            value={day}
            onChange={setDay}
            size="md"
            aria-label="Which day"
            items={[{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }]}
          />
          {ov && <span className="text-sm text-gray-500">{ov.date}</span>}
          {day === 'tomorrow' && ov && !pastCutoff && (
            <Badge tone="info">Shops are still setting tomorrow's prices</Badge>
          )}
        </div>
      )}

      {tab === 'prices' && (
        <>
          <StatGrid columns={4}>
            <StatCard label="Regions" value={ov ? String(ov.regions.length) : '—'} />
            <StatCard label={`Shops submitted for ${day}`} value={ov ? `${submittedCount} / ${ov.stores.length}` : '—'} />
            <StatCard label="Items with a region price" value={ov ? String(ov.prices.filter((p) => p.price != null).length) : '—'} />
            <StatCard label="Flagged (ignored as too high)" value={ov ? String(flaggedTotal) : '—'} />
          </StatGrid>

          <Card>
            <CardHeader
              title={`Prices in ${regionName(regionId)} — ${day}`}
              description="What customers pay: admin's price, else the highest shop price (ignoring any far above the middle price), else the catalogue price. Never above MRP."
              actions={
                <div className="flex flex-wrap gap-2">
                  <Select value={regionId} onChange={(e) => setRegionId(e.target.value)} aria-label="Region" selectSize="sm">
                    {(ov?.regions ?? []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.pincodes.join(', ') || 'no pincodes'})</option>)}
                  </Select>
                  <SearchInput value={search} onChange={setSearch} placeholder="Find any loose item to price" />
                </div>
              }
            />
            <TableContainer>
              <Table>
                <THead>
                  <Tr>
                    <Th>Item</Th>
                    <Th>Shops' prices</Th>
                    <Th align="right">Worked out</Th>
                    <Th align="right">Customers pay</Th>
                    {canEdit && <Th>Set {day}'s price</Th>}
                  </Tr>
                </THead>
                <TBody>
                  {loading && !ov ? (
                    <TableSkeletonRows rows={5} cols={canEdit ? 5 : 4} />
                  ) : rows.length === 0 ? (
                    <TableEmptyRow colSpan={canEdit ? 5 : 4}>
                      {search ? 'No loose item matches.' : `No shop in ${regionName(regionId)} has a price for ${day} yet. Search to set one.`}
                    </TableEmptyRow>
                  ) : (
                    rows.map(({ item, row, shops, flagged }) => {
                      const eff = effectivePrice(item, row);
                      return (
                        <Tr key={item.id}>
                          <Td>
                            <div className="font-medium text-gray-900">{item.name}</div>
                            <div className="text-xs text-gray-500">
                              Catalogue {formatCurrency(item.catalogue_price)}/kg{item.mrp ? ` · MRP ${formatCurrency(item.mrp)}` : ''}
                              {item.piece_weight_g ? ` · ~${item.piece_weight_g} g a piece` : ''}
                            </div>
                          </Td>
                          <Td>
                            {shops.length === 0 ? <span className="text-sm text-gray-400">None</span> : (
                              <div className="flex flex-wrap gap-1.5">
                                {shops.map((s) => (
                                  <button
                                    key={s.store.id}
                                    type="button"
                                    disabled={!canEdit}
                                    onClick={() => setCorrecting({ store: s.store, item, price: s.price })}
                                    title={canEdit ? `Correct or remove ${s.store.name}'s price` : undefined}
                                    className={`rounded-full border px-2 py-0.5 text-xs ${s.flagged ? 'border-red-300 bg-red-50 text-red-700 line-through' : 'border-gray-200 bg-gray-50 text-gray-700'} ${canEdit ? 'hover:border-gray-400' : ''}`}
                                  >
                                    {s.store.name}: {s.price == null ? 'removed' : formatCurrency(s.price, { paise: s.price % 1 !== 0 })}
                                    {s.source === 'admin' ? ' (admin)' : ''}
                                    {!s.store.loose_price_counts ? ' (left out)' : ''}
                                  </button>
                                ))}
                              </div>
                            )}
                            {flagged > 0 && (
                              <div className="mt-1 flex items-center gap-1 text-xs text-red-700">
                                <AlertTriangle className="h-3 w-3" /> {flagged} ignored as too far above the middle price
                              </div>
                            )}
                          </Td>
                          <Td align="right">{row?.computed_price != null ? formatCurrency(row.computed_price, { paise: row.computed_price % 1 !== 0 }) : '—'}</Td>
                          <Td align="right">
                            <div className="font-semibold">{formatCurrency(eff.price, { paise: eff.price % 1 !== 0 })}</div>
                            <Badge tone={eff.source === 'admin' ? 'brand' : eff.source === 'shops' ? 'success' : 'neutral'}>
                              {eff.source === 'admin' ? 'Admin' : eff.source === 'shops' ? 'Shops' : 'Catalogue'}
                            </Badge>
                          </Td>
                          {canEdit && (
                            <Td>
                              <div className="flex items-center gap-2">
                                <Input
                                  inputSize="sm"
                                  type="number"
                                  min={1}
                                  step="0.5"
                                  placeholder="₹/kg"
                                  aria-label={`${item.name} price for ${day}`}
                                  value={drafts[item.id] ?? ''}
                                  onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === 'Enter') submitDraft(item); }}
                                  className="w-24"
                                />
                                <Button size="sm" onClick={() => submitDraft(item)} loading={busy === `price:${item.id}`}>Set</Button>
                                {row?.admin_price != null && (
                                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void setRegionPrice(item, null)}>Clear</Button>
                                )}
                              </div>
                            </Td>
                          )}
                        </Tr>
                      );
                    })
                  )}
                </TBody>
              </Table>
            </TableContainer>
          </Card>
        </>
      )}

      {tab === 'shops' && ov && (
        <ShopsTab
          ov={ov}
          day={day}
          pastCutoff={pastCutoff}
          canEdit={canEdit}
          canEditStores={canEditStores}
          regionName={regionName}
          onChanged={() => load(day)}
          confirm={confirm}
          showToast={showToast}
        />
      )}

      {tab === 'regions' && <RegionsTab canEdit={canEdit} showToast={showToast} />}

      {tab === 'settings' && ov && <SettingsTab settings={ov.settings} canEdit={canEdit} showToast={showToast} onSaved={() => load(day)} />}

      <Modal
        open={!!correcting}
        onClose={() => setCorrecting(null)}
        title={correcting ? `${correcting.store.name}: ${correcting.item.name}` : ''}
        description="Changes the shop's saved price for this day and works the region's price out again. The shop still sells at the region's price."
        footer={
          <div className="flex justify-between gap-2">
            <Button variant="dangerOutline" onClick={() => void correctShopPrice(null)} loading={busy === 'correct'}>Remove this price</Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setCorrecting(null)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (!correcting) return;
                  const parsed = parseAdminPrice(drafts[`shop:${correcting.store.id}`] ?? '', correcting.item.mrp);
                  if ('error' in parsed) return showToast(parsed.error, 'error');
                  void correctShopPrice(parsed.price);
                }}
                loading={busy === 'correct'}
              >
                Save
              </Button>
            </div>
          </div>
        }
      >
        {correcting && (
          <FormField label="Correct price (₹ per kg)" hint={`Now ${correcting.price == null ? 'removed' : `₹${correcting.price}`}`}>
            <Input
              type="number"
              min={1}
              step="0.5"
              autoFocus
              value={drafts[`shop:${correcting.store.id}`] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [`shop:${correcting.store.id}`]: e.target.value }))}
            />
          </FormField>
        )}
      </Modal>
    </div>
  );
};

// ── Shops ────────────────────────────────────────────────────────────────────

function ShopsTab(props: {
  ov: LooseOverview;
  day: Day;
  pastCutoff: boolean;
  canEdit: boolean;
  canEditStores: boolean;
  regionName: (id: string | null) => string;
  onChanged: () => Promise<void>;
  confirm: ReturnType<typeof useConfirm>;
  showToast: (m: string, t?: 'success' | 'error' | 'info' | 'warning') => void;
}) {
  const { ov, day, pastCutoff, canEdit, canEditStores, regionName, onChanged, confirm, showToast } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      showToast(done, 'success');
      await onChanged();
    } catch (err) {
      showToast(errorMessage(err, 'Something went wrong'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Shops"
        description="A shop left out of the calculation still sells at its region's price. Reopening lets a shop change tomorrow's prices again until the cut-off. Pincode changes decide the shop's region."
      />
      <TableContainer>
        <Table>
          <THead>
            <Tr>
              <Th>Shop</Th>
              <Th>Pincode</Th>
              <Th>Region</Th>
              <Th>Prices for {day}</Th>
              <Th>Counts towards the price</Th>
              {canEdit && day === 'tomorrow' && <Th />}
            </Tr>
          </THead>
          <TBody>
            {ov.stores.length === 0 ? (
              <TableEmptyRow colSpan={6}>No approved shops.</TableEmptyRow>
            ) : (
              ov.stores.map((s) => (
                <Tr key={s.id}>
                  <Td className="font-medium text-gray-900">{s.name}</Td>
                  <Td>
                    {canEditStores ? (
                      <div className="flex items-center gap-2">
                        <Input
                          inputSize="sm"
                          className="w-24"
                          inputMode="numeric"
                          maxLength={6}
                          aria-label={`${s.name} pincode`}
                          value={pins[s.id] ?? s.pincode ?? ''}
                          onChange={(e) => setPins((p) => ({ ...p, [s.id]: e.target.value.replace(/\D/g, '') }))}
                        />
                        {(pins[s.id] ?? s.pincode ?? '') !== (s.pincode ?? '') && (
                          <Button
                            size="sm"
                            loading={busy === `pin:${s.id}`}
                            onClick={() => {
                              const pin = pins[s.id] ?? '';
                              if (pin && !PINCODE_RE.test(pin)) return showToast('Pincode must be 6 digits', 'error');
                              void run(`pin:${s.id}`, () => call(`/api/admin/stores/${s.id}/pincode`, 'PUT', { pincode: pin || null }), `${s.name}: pincode saved`);
                            }}
                          >
                            Save
                          </Button>
                        )}
                      </div>
                    ) : (s.pincode ?? '—')}
                  </Td>
                  <Td>{s.region_id ? regionName(s.region_id) : <Badge tone="warning">No region</Badge>}</Td>
                  <Td className="text-sm text-gray-600">{sheetStatusLabel(s, (iso) => formatTime(iso))}</Td>
                  <Td>
                    <Toggle
                      checked={s.loose_price_counts}
                      disabled={!canEdit || busy !== null}
                      aria-label={`${s.name} counts towards the price`}
                      onChange={async (next) => {
                        const ok = await confirm(next
                          ? { title: `Count ${s.name} again?`, message: "Its prices will count towards its region's price again.", confirmLabel: 'Count it' }
                          : { title: `Leave ${s.name} out?`, message: "Its prices won't count towards its region's price. It still sells at the region's price.", confirmLabel: 'Leave out', tone: 'danger' });
                        if (!ok) return;
                        void run(`counts:${s.id}`, () => call(`/api/admin/loose-prices/stores/${s.id}/counts`, 'PUT', { counts: next }), next ? `${s.name} counts again` : `${s.name} left out`);
                      }}
                    />
                  </Td>
                  {canEdit && day === 'tomorrow' && (
                    <Td align="right">
                      {s.submitted_at && !pastCutoff && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `reopen:${s.id}`}
                          onClick={async () => {
                            if (!(await confirm({ title: `Reopen ${s.name}'s prices?`, message: `${s.name} can save and submit tomorrow's prices again until ${clockLabel(ov.settings.cutoff_time)}. The shop is notified.`, confirmLabel: 'Reopen' }))) return;
                            void run(`reopen:${s.id}`, () => call(`/api/admin/loose-prices/stores/${s.id}/reopen`, 'POST'), `${s.name} can change tomorrow's prices again`);
                          }}
                        >
                          Reopen
                        </Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))
            )}
          </TBody>
        </Table>
      </TableContainer>
    </Card>
  );
}

// ── Regions ──────────────────────────────────────────────────────────────────

function RegionsTab({ canEdit, showToast }: { canEdit: boolean; showToast: (m: string, t?: 'success' | 'error' | 'info' | 'warning') => void }) {
  const [data, setData] = useState<RegionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [pin, setPin] = useState('');
  const [pinRegion, setPinRegion] = useState('');
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await call<RegionsResponse & { success: boolean }>('/api/admin/price-regions'));
    } catch (err) {
      setError(errorMessage(err, 'Could not load regions'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      showToast(done, 'success');
      await load();
    } catch (err) {
      showToast(errorMessage(err, 'Something went wrong'), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (error) return <Alert tone="danger" title="Couldn't load regions" actions={<Button size="sm" onClick={() => void load()}>Retry</Button>}>{error}</Alert>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Regions"
          description="A region is one locality, with one or more pincodes. Pincode changes apply from tomorrow, so prices never jump in the middle of a day."
        />
        <TableContainer>
          <Table>
            <THead>
              <Tr>
                <Th>Region</Th>
                <Th>Pincodes today</Th>
                <Th>From tomorrow</Th>
              </Tr>
            </THead>
            <TBody>
              {loading && !data ? <TableSkeletonRows rows={4} cols={3} /> : (data?.regions ?? []).map((r) => {
                const changed = r.pincodes.join(',') !== r.pincodes_from_tomorrow.join(',');
                return (
                  <Tr key={r.id}>
                    <Td>
                      {canEdit ? (
                        <div className="flex items-center gap-2">
                          <Input inputSize="sm" className="w-48" aria-label={`Rename ${r.name}`} value={renames[r.id] ?? r.name} onChange={(e) => setRenames((x) => ({ ...x, [r.id]: e.target.value }))} />
                          {(renames[r.id] ?? r.name) !== r.name && (
                            <Button size="sm" loading={busy === `rename:${r.id}`} onClick={() => void run(`rename:${r.id}`, () => call(`/api/admin/price-regions/${r.id}`, 'PATCH', { name: renames[r.id] }), 'Region renamed')}>Save</Button>
                          )}
                        </div>
                      ) : <span className="font-medium">{r.name}</span>}
                    </Td>
                    <Td>{r.pincodes.join(', ') || '—'}</Td>
                    <Td>{changed ? <Badge tone="info">{r.pincodes_from_tomorrow.join(', ') || 'none'}</Badge> : <span className="text-gray-400">Same</span>}</Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </TableContainer>
      </Card>

      {canEdit && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader title="Add a region" />
            <CardBody>
              <div className="flex gap-2">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Jadavpur" aria-label="New region name" />
                <Button
                  loading={busy === 'create'}
                  onClick={() => {
                    if (newName.trim().length < 2) return showToast('Enter a region name', 'error');
                    void run('create', () => call('/api/admin/price-regions', 'POST', { name: newName.trim() }), `${newName.trim()} added`).then(() => setNewName(''));
                  }}
                >
                  Add
                </Button>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Put a pincode in a region" description="Applies from tomorrow." />
            <CardBody>
              <div className="flex flex-wrap gap-2">
                <Input className="w-28" inputMode="numeric" maxLength={6} placeholder="700084" aria-label="Pincode" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
                <Select value={pinRegion} onChange={(e) => setPinRegion(e.target.value)} aria-label="Region for the pincode">
                  <option value="">No region</option>
                  {(data?.regions ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
                <Button
                  loading={busy === 'pin'}
                  onClick={() => {
                    if (!PINCODE_RE.test(pin)) return showToast('Pincode must be 6 digits', 'error');
                    void run('pin', () => call(`/api/admin/price-regions/pincodes/${pin}`, 'PUT', { region_id: pinRegion || null }), `${pin} updated from tomorrow`).then(() => setPin(''));
                  }}
                >
                  Save
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

function SettingsTab({ settings, canEdit, showToast, onSaved }: {
  settings: LooseSettings;
  canEdit: boolean;
  showToast: (m: string, t?: 'success' | 'error' | 'info' | 'warning') => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    band_below_pct: String(settings.band_below_pct),
    band_above_pct: String(settings.band_above_pct),
    daily_move_pct: String(settings.daily_move_pct),
    outlier_pct: String(settings.outlier_pct),
    stale_days: String(settings.stale_days),
    cutoff_time: settings.cutoff_time,
    notify_time: settings.notify_time,
    reminder_times: settings.reminder_times.join(', '),
  });
  const [saving, setSaving] = useState(false);
  const field = (key: keyof typeof form, label: string, hint: string, type = 'number') => (
    <FormField label={label} hint={hint} htmlFor={`lp-${key}`}>
      <Input id={`lp-${key}`} type={type} disabled={!canEdit} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </FormField>
  );

  const save = async () => {
    setSaving(true);
    try {
      await call('/api/admin/loose-prices/settings', 'PUT', {
        band_below_pct: Number(form.band_below_pct),
        band_above_pct: Number(form.band_above_pct),
        daily_move_pct: Number(form.daily_move_pct),
        outlier_pct: Number(form.outlier_pct),
        stale_days: Number(form.stale_days),
        cutoff_time: form.cutoff_time,
        notify_time: form.notify_time,
        reminder_times: form.reminder_times.split(',').map((t) => t.trim()).filter(Boolean),
      });
      showToast('Settings saved', 'success');
      await onSaved();
    } catch (err) {
      showToast(errorMessage(err, 'Could not save the settings'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Guardrails and timings" description="Apply from the next price shops save. Changes don't need an app release." />
      <CardBody>
        <div className="grid gap-4 md:grid-cols-2">
          {field('band_below_pct', 'Lowest, % below the catalogue price', 'Default 30')}
          {field('band_above_pct', 'Highest, % above the catalogue price', 'Default 20')}
          {field('daily_move_pct', 'Most a price can move in a day, %', 'Default 15, against today\'s price')}
          {field('outlier_pct', 'Ignore prices this % above the middle price', 'Default 10')}
          {field('stale_days', 'A shop\'s old price counts for (days)', 'Default 7')}
          {field('cutoff_time', 'Cut-off (shops set prices until)', 'Default 20:00', 'time')}
          {field('notify_time', 'Shops are told tomorrow\'s prices at', 'Default 20:30', 'time')}
          {field('reminder_times', 'Reminders (comma-separated)', 'Default 18:00, 19:00, 19:45', 'text')}
        </div>
      </CardBody>
      {canEdit && (
        <div className="flex justify-end border-t border-gray-100 px-6 py-4">
          <Button onClick={() => void save()} loading={saving}>Save settings</Button>
        </div>
      )}
    </Card>
  );
}

export default LoosePricesPage;
