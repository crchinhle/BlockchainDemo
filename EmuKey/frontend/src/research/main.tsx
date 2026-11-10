import 'antd/dist/reset.css';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import './research.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  ConfigProvider,
  Layout,
  Typography,
  Tag,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Alert,
  Table,
  Tabs,
  Statistic,
  Row,
  Col,
  Timeline,
  Empty,
  Checkbox,
  App as AntApp,
} from 'antd';
import {
  ExperimentOutlined,
  BarChartOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
const { Title, Text, Paragraph } = Typography;
type Config = import('./generated/types.gen').ResearchConfig;
const smoke: Config = {
  name: 'Smoke',
  purpose: 'Kiểm tra luồng tích hợp thật',
  strategy: 'HYBRID',
  variant: 'bounded-snapshot-v1',
  repetitions: 1,
  seed: 42,
  licenses: 1,
  devices: 1,
  maxDevices: 1,
  rate: 10,
  concurrency: 8,
  probeMs: 100,
  cacheTtlMs: 5000,
  tokenTtlMs: 3000,
  pollMs: 1000,
  eventMode: 'healthy',
  eventDelayMs: 2000,
  warmupMs: 300,
  revokeAfterMs: 500,
  observeMs: 6000,
  timeoutMs: 30000,
  confirmations: 1,
  freshnessMs: 5000,
  clients: ['old-token', 'refresh'],
  fault: 'none',
  faultDurationMs: 1000,
};
type Run = {
  id: string;
  name: string;
  state: string;
  config: Config;
  created_at: string;
  error?: string;
  manifest: Record<string, unknown>;
};
type Sample = {
  id: string;
  sequence: number;
  decision: string;
  reason: string;
  client: string;
  source: string;
  latencyMs: number;
  decisionEvaluatedAt: number;
  stale?: boolean;
  ambiguous?: boolean;
};
type Summary = {
  sampleCount: number;
  staleAccepts: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  observedWindowMs: number | null;
  rightCensored: boolean;
  rpcCalls: number;
  cacheHits: number;
  warnings: string[];
};
type Result = {
  run: Run;
  samples: Sample[];
  events: {
    id: string;
    kind: string;
    at: number;
    data: Record<string, unknown>;
  }[];
  repetitions: {
    id: string;
    ordinal: number;
    state: string;
    tc: string | null;
    summary: Summary | null;
  }[];
  summary: Summary;
};
function expandPreset(base: Config, kind: string): Config[] {
  if (kind === 'ttl')
    return [
      ...[5000, 30000, 120000].map((cacheTtlMs) => ({
        ...base,
        cacheTtlMs,
        tokenTtlMs: 15000,
      })),
      ...[5000, 15000, 30000, 60000].map((tokenTtlMs) => ({
        ...base,
        cacheTtlMs: 30000,
        tokenTtlMs,
      })),
    ].map((c, i) => ({
      ...c,
      name: `${base.name} ? TTL ${i + 1}`,
      freshnessMs: c.cacheTtlMs,
      observeMs: Math.max(c.cacheTtlMs, c.tokenTtlMs) + 2000,
      timeoutMs: Math.max(c.cacheTtlMs, c.tokenTtlMs) + 30000,
    }));
  if (kind === 'events')
    return ['healthy', 'delayed', 'dropped'].map((eventMode) => ({
      ...base,
      eventMode,
      name: `${base.name} ? ${eventMode}`,
    }));
  if (kind === 'compare')
    return ['CENTRALIZED', 'DIRECT_ONCHAIN', 'HYBRID'].map((strategy) => ({
      ...base,
      strategy,
      name: `${base.name} ? ${strategy}`,
    }));
  return [base];
}
const qc = new QueryClient();
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/research' + path, {
    credentials: 'same-origin',
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(result.message ?? 'Yêu cầu thất bại');
  return result;
}
const stamp = (v: number | string) =>
  new Date(Number(v)).toLocaleTimeString('vi-VN', { hour12: false });
function Lab() {
  const { message } = AntApp.useApp();
  const [logged, setLogged] = useState(false);
  const [page, setPage] = useState('create');
  const [selected, setSelected] = useState<string | null>(
    new URLSearchParams(location.search).get('run'),
  );
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [compare, setCompare] = useState<string[]>([]);
  const [batch, setBatch] = useState('single');
  const [comparison, setComparison] = useState<{
    compatible: boolean;
    reasons: string[];
    runs: Result[];
  } | null>(null);
  const [form] = Form.useForm<Config>();
  const [health, setHealth] = useState<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  } | null>(null);
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      await api('/me');
      setLogged(true);
      return true;
    },
    retry: false,
  });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => api<Run[]>('/runs'),
    enabled: logged,
    refetchInterval: 1500,
  });
  const detail = useQuery({
    queryKey: ['run', selected],
    queryFn: () => api<Result>('/runs/' + selected),
    enabled: logged && !!selected,
    refetchInterval: 1000,
  });
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await qc.invalidateQueries();
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = (id: string, target = 'monitor') => {
    setSelected(id);
    setPage(target);
    history.replaceState(null, '', `research.html?run=${id}`);
  };
  const start = async (config: Config) => {
    config.probeMs = Math.round(1000 / config.rate);
    const plans = expandPreset(config, batch);
    const created: Run[] = [];
    for (const item of plans) created.push(await api<Run>('/runs', item));
    for (const run of created) await api('/runs/' + run.id + '/start', {});
    if (created[0]) choose(created[0].id);
  };
  const values = Form.useWatch([], form) as Config | undefined;
  const plan = { ...smoke, ...values };
  const plans = expandPreset(plan, batch);
  const result = detail.data;
  const chartStart = result?.samples.length
    ? Math.min(...result.samples.map((s) => s.decisionEvaluatedAt))
    : 0;
  const chartEnd = result?.samples.length
    ? Math.max(...result.samples.map((s) => s.decisionEvaluatedAt))
    : 1;
  if (!logged)
    return (
      <main className="login">
        <Tag color="blue">RESEARCH-LOCAL · CHAIN 31337</Tag>
        <Title>
          EmuKey
          <br />
          Research Lab
        </Title>
        <Paragraph>
          Điều khiển thí nghiệm thu hồi giấy phép và kiểm tra bằng chứng từ lượt
          chạy thật.
        </Paragraph>
        <Card title="Đăng nhập nhà nghiên cứu">
          <Form
            layout="vertical"
            onFinish={(v: { username: string; password: string }) =>
              void act(async () => {
                await api('/login', v);
                setLogged(true);
              })
            }
          >
            <Form.Item
              name="username"
              label="Tên đăng nhập"
              initialValue="researcher"
              rules={[{ required: true }]}
            >
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item
              name="password"
              label="Mật khẩu local"
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy} block>
              Đăng nhập
            </Button>
          </Form>
          <Paragraph type="secondary" style={{ marginTop: 16 }}>
            Thông tin đăng nhập được tạo khi thiết lập môi trường; xem README
            của dự án.
          </Paragraph>
        </Card>
      </main>
    );
  return (
    <Layout className="shell">
      <Layout.Sider
        width={240}
        breakpoint="lg"
        collapsedWidth={0}
        theme="light"
      >
        <div className="brand">
          <ExperimentOutlined aria-hidden />
          <strong>
            EmuKey <small>RESEARCH LAB</small>
          </strong>
        </div>
        <nav>
          {(
            [
              ['create', 'Tạo thí nghiệm', <ExperimentOutlined aria-hidden />],
              [
                'monitor',
                'Theo dõi lượt chạy',
                <PlayCircleOutlined aria-hidden />,
              ],
              [
                'reports',
                'Báo cáo nghiên cứu',
                <BarChartOutlined aria-hidden />,
              ],
            ] as const
          ).map(([key, label, icon]) => (
            <Button
              key={String(key)}
              type={page === key ? 'primary' : 'text'}
              icon={icon}
              onClick={() => setPage(String(key))}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="side-note">
          <Tag color="green">LOCAL EVM</Tag>
          <p>Chain ID 31337</p>
          <Text type="secondary">
            Dữ liệu thực nghiệm.
            <br />
            Không dùng số liệu demo.
          </Text>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header>
          <Text>
            Phòng thí nghiệm /{' '}
            {page === 'create'
              ? 'Thiết kế'
              : page === 'monitor'
                ? 'Quan sát'
                : 'Phân tích'}
          </Text>
          <Space>
            <Tag>bounded-snapshot-v1</Tag>
            <Button
              onClick={() =>
                void act(async () => {
                  await api('/logout', {});
                  setLogged(false);
                })
              }
            >
              Đăng xuất
            </Button>
          </Space>
        </Layout.Header>
        <Layout.Content>
          <div className="page-title">
            <div>
              <Text className="eyebrow">LICENSE REVOCATION EXPERIMENTS</Text>
              <Title level={2}>
                {page === 'create'
                  ? 'Thiết kế một thí nghiệm'
                  : page === 'monitor'
                    ? 'Theo dõi lượt chạy'
                    : 'Báo cáo nghiên cứu'}
              </Title>
              <Paragraph type="secondary">
                {page === 'create'
                  ? 'Cấu hình workload, chính sách freshness và thời gian quan sát.'
                  : page === 'monitor'
                    ? 'Worker thực thi độc lập với trình duyệt. Timeline được ghi tại backend.'
                    : 'Kiểm tra latency, stale authorization và giới hạn quan sát cùng nhau.'}
              </Paragraph>
            </div>
            <Button
              icon={<ReloadOutlined aria-hidden />}
              onClick={() =>
                void act(async () => setHealth(await api('/preflight')))
              }
            >
              Kiểm tra môi trường
            </Button>
          </div>
          {health && (
            <Alert
              style={{ marginBottom: 20 }}
              type={health.ok ? 'success' : 'error'}
              showIcon
              title={
                health.ok ? 'Môi trường sẵn sàng' : 'Môi trường chưa sẵn sàng'
              }
              description={health.checks
                .map((c) => `${c.name}: ${c.ok ? 'OK' : c.detail}`)
                .join(' · ')}
            />
          )}
          {page === 'create' && (
            <Row gutter={24}>
              <Col xs={24} xl={17}>
                <Card>
                  <Form
                    form={form}
                    initialValues={smoke}
                    layout="vertical"
                    onFinish={(v) => void act(() => start({ ...smoke, ...v }))}
                  >
                    <div className="section-title">
                      01 / Mục tiêu và phương pháp
                    </div>
                    <Form.Item
                      name="name"
                      label="Tên thí nghiệm"
                      rules={[{ required: true, max: 100 }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item name="purpose" label="Mục đích">
                      <Input.TextArea rows={2} />
                    </Form.Item>
                    <Form.Item name="strategy" label="Chiến lược">
                      <Select
                        options={[
                          'HYBRID',
                          'CENTRALIZED',
                          'DIRECT_ONCHAIN',
                        ].map((value) => ({
                          value,
                          label:
                            value === 'DIRECT_ONCHAIN'
                              ? 'DIRECT_ONCHAIN · trạng thái chain + thiết bị off-chain'
                              : value,
                        }))}
                      />
                    </Form.Item>
                    <Form.Item name="eventMode" label="Event invalidation">
                      <Select
                        options={['healthy', 'delayed', 'dropped'].map(
                          (value) => ({ value, label: value }),
                        )}
                      />
                    </Form.Item>
                    <Form.Item name="clients" label="Nhóm client">
                      <Checkbox.Group options={['old-token', 'refresh']} />
                    </Form.Item>
                    <div className="section-title">
                      02 / Workload và thời gian
                    </div>
                    <Row gutter={16}>
                      {(
                        [
                          ['repetitions', 'Số repetitions'],
                          ['seed', 'Seed workload'],
                          ['licenses', 'Giấy phép / repetition'],
                          ['devices', 'Thiết bị / giấy phép'],
                          ['maxDevices', 'Giới hạn thiết bị'],
                          ['rate', 'Nhịp yêu cầu / giây / client'],
                          ['concurrency', 'Giới hạn đồng thời'],
                          ['cacheTtlMs', 'Cache TTL C (ms)'],
                          ['tokenTtlMs', 'Token TTL T (ms)'],
                          ['freshnessMs', 'Freshness threshold (ms)'],
                          ['pollMs', 'Polling interval (ms)'],
                          ['eventDelayMs', 'Độ trễ event (ms)'],
                          ['warmupMs', 'Warmup (ms)'],
                          ['revokeAfterMs', 'Thu hồi sau warmup (ms)'],
                          ['observeMs', 'Quan sát sau mốc gửi (ms)'],
                          ['timeoutMs', 'Timeout run (ms)'],
                          ['confirmations', 'Số confirmations'],
                          ['faultDurationMs', 'Thời gian fault (ms)'],
                        ] as const
                      ).map(([key, label]) => (
                        <Col xs={24} sm={12} key={key}>
                          <Form.Item
                            name={key}
                            label={label}
                            rules={[{ required: true }]}
                          >
                            <InputNumber min={0} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                      ))}
                    </Row>
                    <Form.Item
                      name="fault"
                      label="Fault injection · chỉ research-local"
                    >
                      <Select
                        options={['none', 'rpc-outage', 'cache-race'].map(
                          (value) => ({ value, label: value }),
                        )}
                      />
                    </Form.Item>
                    <Space wrap>
                      <Button
                        type="primary"
                        htmlType="submit"
                        icon={<PlayCircleOutlined aria-hidden />}
                        loading={busy}
                      >
                        Chạy thí nghiệm
                      </Button>
                      <Button
                        onClick={() =>
                          void act(async () => {
                            await api('/runs', {
                              ...smoke,
                              ...(await form.validateFields()),
                            });
                            void message.success('Đã lưu cấu hình');
                          })
                        }
                      >
                        Lưu cấu hình
                      </Button>
                    </Space>
                  </Form>
                </Card>
              </Col>
              <Col xs={24} xl={7}>
                <Card title="Kế hoạch chạy" className="sticky">
                  <label htmlFor="preset-batch">Nhóm cấu hình</label>
                  <Select
                    id="preset-batch"
                    style={{ width: '100%', marginBottom: 16 }}
                    value={batch}
                    onChange={setBatch}
                    options={[
                      { value: 'single', label: 'Một cấu hình' },
                      { value: 'ttl', label: 'TTL sensitivity · 7 cấu hình' },
                      { value: 'events', label: 'Event delay · 3 cấu hình' },
                      { value: 'compare', label: 'Comparative · 3 chiến lược' },
                    ]}
                  />
                  <Paragraph>
                    {plans.length} cấu hình × {plan.repetitions} repetitions;
                    worker chạy tuần tự.
                  </Paragraph>
                  <Tag color="blue">REAL TRANSACTIONS</Tag>
                  <Statistic
                    title="Số yêu cầu dự kiến tối đa"
                    value={Math.ceil(
                      plans.reduce(
                        (sum, p) =>
                          sum +
                          ((p.repetitions *
                            p.rate *
                            (p.revokeAfterMs + p.observeMs)) /
                            1000) *
                            p.clients.length *
                            p.licenses *
                            p.devices,
                        0,
                      ),
                    )}
                  />
                  <Paragraph>
                    Issue → activate → warm → revoke → observe → report
                  </Paragraph>
                  <Alert
                    type="info"
                    title="Token bị giới hạn bởi snapshot"
                    description="exp = min(iat + T, snapshot time + C, freshness deadline, license expiry). Cache hit không làm mới snapshot."
                  />
                  <Paragraph style={{ marginTop: 18 }}>
                    Smoke chỉ chứng minh luồng tích hợp, không đủ để kết luận
                    hiệu năng hoặc an toàn.
                  </Paragraph>
                  <Button block onClick={() => form.setFieldsValue(smoke)}>
                    Preset Smoke
                  </Button>
                  <Button
                    block
                    style={{ marginTop: 8 }}
                    onClick={() =>
                      form.setFieldsValue({
                        ...smoke,
                        name: 'TTL sensitivity',
                        cacheTtlMs: 30000,
                        tokenTtlMs: 15000,
                        freshnessMs: 30000,
                        repetitions: 10,
                        observeMs: 35000,
                        timeoutMs: 60000,
                      })
                    }
                  >
                    Preset TTL · 10 repetitions
                  </Button>
                  <Button
                    block
                    style={{ marginTop: 8 }}
                    onClick={() =>
                      form.setFieldsValue({
                        ...smoke,
                        name: 'Event delay',
                        eventMode: 'delayed',
                        eventDelayMs: 2000,
                        pollMs: 10000,
                      })
                    }
                  >
                    Preset Event delay
                  </Button>
                </Card>
              </Col>
            </Row>
          )}
          {page !== 'create' && (
            <>
              <Card style={{ marginBottom: 24 }} title="Lượt chạy đã lưu">
                <Table
                  rowKey="id"
                  dataSource={runs.data ?? []}
                  size="small"
                  pagination={{ pageSize: 5 }}
                  rowSelection={{
                    selectedRowKeys: compare,
                    onChange: (keys) => setCompare(keys.map(String)),
                  }}
                  columns={[
                    {
                      title: 'Thí nghiệm',
                      dataIndex: 'name',
                      render: (name: string, r: Run) => (
                        <Button type="link" onClick={() => choose(r.id, page)}>
                          {name}
                        </Button>
                      ),
                    },
                    {
                      title: 'Chiến lược',
                      render: (_, r: Run) => r.config.strategy,
                    },
                    {
                      title: 'Trạng thái',
                      dataIndex: 'state',
                      render: (v: string) => (
                        <Tag
                          color={
                            v === 'COMPLETED'
                              ? 'green'
                              : v === 'FAILED'
                                ? 'red'
                                : 'blue'
                          }
                        >
                          {v}
                        </Tag>
                      ),
                    },
                    {
                      title: 'Repetitions',
                      render: (_, r: Run) => r.config.repetitions,
                    },
                  ]}
                />
                {page === 'reports' && (
                  <Button
                    disabled={compare.length < 2}
                    onClick={() =>
                      void act(async () => {
                        const c = await api<{
                          compatible: boolean;
                          reasons: string[];
                          runs: Result[];
                        }>('/compare', { ids: compare });
                        setComparison(c);
                        void message.info(
                          c.compatible
                            ? 'Workload và môi trường tương thích để xem xét so sánh.'
                            : c.reasons.join(' '),
                        );
                      })
                    }
                  >
                    Kiểm tra tính tương thích
                  </Button>
                )}
              </Card>
              {comparison && page === 'reports' && (
                <Card
                  title="So s?nh theo repetition"
                  style={{ marginBottom: 24 }}
                >
                  <Alert
                    type={comparison.compatible ? 'info' : 'warning'}
                    title={
                      comparison.compatible
                        ? 'C?ng workload v? m?i tr??ng'
                        : 'Kh?ng ?? ?i?u ki?n so s?nh tr?c ti?p'
                    }
                    description={
                      comparison.reasons.join(' ') ||
                      'Lu?n xem stale authorization c?ng latency v? availability.'
                    }
                  />
                  <Table
                    rowKey="id"
                    dataSource={comparison.runs.flatMap((r) =>
                      r.repetitions.map((rep) => ({
                        id: rep.id,
                        name: r.run.name,
                        strategy: r.run.config.strategy,
                        c: r.run.config.cacheTtlMs,
                        t: r.run.config.tokenTtlMs,
                        ordinal: rep.ordinal,
                        ...rep.summary,
                      })),
                    )}
                    columns={[
                      { title: 'Run', dataIndex: 'name' },
                      { title: 'Strategy', dataIndex: 'strategy' },
                      { title: 'C (ms)', dataIndex: 'c' },
                      { title: 'T (ms)', dataIndex: 't' },
                      { title: 'Rep', dataIndex: 'ordinal' },
                      {
                        title: 'P95 ms',
                        dataIndex: 'p95Ms',
                        render: (v: number) => v?.toFixed(2) ?? 'N/A',
                      },
                      { title: 'Stale', dataIndex: 'staleAccepts' },
                      { title: 'RPC calls', dataIndex: 'rpcCalls' },
                    ]}
                    scroll={{ x: 850 }}
                  />
                </Card>
              )}
              {!result ? (
                <Empty description="Chọn một lượt chạy để xem dữ liệu" />
              ) : (
                <>
                  <Card
                    title={
                      <Space>
                        {result.run.name}
                        <Tag>{result.run.state}</Tag>
                      </Space>
                    }
                    extra={
                      <Space>
                        <Button
                          danger
                          disabled={[
                            'COMPLETED',
                            'FAILED',
                            'CANCELLED',
                            'INTERRUPTED',
                          ].includes(result.run.state)}
                          onClick={() =>
                            void act(() =>
                              api('/runs/' + selected + '/cancel', {}),
                            )
                          }
                        >
                          Hủy lượt chạy
                        </Button>
                        <Button
                          onClick={() =>
                            void act(async () => {
                              const r = await api<Run>(
                                '/runs/' + selected + '/retry',
                                {},
                              );
                              await api('/runs/' + r.id + '/start', {});
                              choose(r.id);
                            })
                          }
                        >
                          Chạy lại thành lượt mới
                        </Button>
                      </Space>
                    }
                  >
                    {result.run.error && (
                      <Alert type="error" title={result.run.error} />
                    )}
                    <Row gutter={[20, 20]}>
                      {[
                        ['Mẫu đã ghi', result.summary.sampleCount],
                        ['Stale acceptance', result.summary.staleAccepts],
                        ['P50 (ms)', result.summary.p50Ms?.toFixed(2) ?? 'N/A'],
                        ['P95 (ms)', result.summary.p95Ms?.toFixed(2) ?? 'N/A'],
                      ].map(([label, value]) => (
                        <Col xs={12} md={6} key={String(label)}>
                          <Statistic title={label} value={value ?? 'N/A'} />
                        </Col>
                      ))}
                    </Row>
                    <div className="chart">
                      <svg
                        viewBox="0 0 1000 200"
                        role="img"
                        aria-label="Quyết định xác minh theo thứ tự mẫu"
                      >
                        <text x="0" y="40">
                          ALLOW
                        </text>
                        <text x="0" y="130">
                          DENY / lỗi
                        </text>
                        <line
                          x1="90"
                          x2="990"
                          y1="160"
                          y2="160"
                          stroke="#ccd4df"
                        />
                        {result.samples.map((s) => (
                          <circle
                            key={s.id}
                            cx={
                              95 +
                              ((s.decisionEvaluatedAt - chartStart) * 880) /
                                Math.max(1, chartEnd - chartStart)
                            }
                            cy={s.decision === 'ALLOW' ? 35 : 125}
                            r={s.stale ? 4 : 2.5}
                            fill={
                              s.stale
                                ? '#d97706'
                                : s.decision === 'ALLOW'
                                  ? '#13795b'
                                  : '#1e40af'
                            }
                          >
                            <title>
                              {s.client} · {s.decision} · {s.reason} ·{' '}
                              {stamp(s.decisionEvaluatedAt)}
                            </title>
                          </circle>
                        ))}
                        {result.repetitions
                          .filter((r) => r.tc)
                          .map((r) => (
                            <g key={r.id}>
                              <line
                                x1={
                                  95 +
                                  ((Number(r.tc) - chartStart) * 880) /
                                    Math.max(1, chartEnd - chartStart)
                                }
                                x2={
                                  95 +
                                  ((Number(r.tc) - chartStart) * 880) /
                                    Math.max(1, chartEnd - chartStart)
                                }
                                y1={10}
                                y2={160}
                                stroke="#b45309"
                                strokeDasharray="4 4"
                              />
                              <title>
                                t_c repetition {r.ordinal}: {stamp(r.tc!)}
                              </title>
                            </g>
                          ))}
                        <text x="90" y="190">
                          Thứ tự mẫu — {result.samples.length} quan sát; màu
                          cam: stale đã xác định
                        </text>
                      </svg>
                    </div>
                    {page === 'monitor' ? (
                      <Tabs
                        items={[
                          {
                            key: 'timeline',
                            label: 'Timeline & receipt',
                            children: (
                              <Timeline
                                items={result.events.map((e) => ({
                                  content: (
                                    <>
                                      <Text code>{stamp(e.at)}</Text>{' '}
                                      <strong>{e.kind}</strong>
                                      <Paragraph className="event-data">
                                        {JSON.stringify(e.data)}
                                      </Paragraph>
                                    </>
                                  ),
                                }))}
                              />
                            ),
                          },
                          {
                            key: 'samples',
                            label: 'Log xác minh',
                            children: (
                              <>
                                <Select
                                  value={filter}
                                  onChange={setFilter}
                                  options={[
                                    'ALL',
                                    'ALLOW',
                                    'DENY',
                                    'ERROR',
                                    'DROPPED',
                                  ].map((value) => ({ value, label: value }))}
                                />
                                <Table
                                  rowKey="id"
                                  size="small"
                                  scroll={{ x: 700 }}
                                  dataSource={result.samples.filter(
                                    (s) =>
                                      filter === 'ALL' || s.decision === filter,
                                  )}
                                  pagination={{ pageSize: 20 }}
                                  columns={[
                                    { title: '#', dataIndex: 'sequence' },
                                    { title: 'Client', dataIndex: 'client' },
                                    {
                                      title: 'Decision',
                                      dataIndex: 'decision',
                                    },
                                    { title: 'Reason', dataIndex: 'reason' },
                                    { title: 'Nguồn', dataIndex: 'source' },
                                    {
                                      title: 'ms',
                                      dataIndex: 'latencyMs',
                                      render: (v: number) => v.toFixed(2),
                                    },
                                  ]}
                                />
                              </>
                            ),
                          },
                        ]}
                      />
                    ) : (
                      <>
                        <Alert
                          type="warning"
                          title="Giới hạn diễn giải"
                          description="Không có stale quan sát được không chứng minh cửa sổ thật bằng 0. P99 dưới 100 mẫu có độ tin cậy thấp. CPU/RAM chưa đo. Không suy ra Hybrid tốt hơn chỉ từ latency."
                        />
                        <Table
                          rowKey="id"
                          dataSource={result.repetitions}
                          pagination={false}
                          columns={[
                            { title: 'Repetition', dataIndex: 'ordinal' },
                            { title: 'Trạng thái', dataIndex: 'state' },
                            {
                              title: 'Stale',
                              render: (_, r: Result['repetitions'][number]) =>
                                r.summary?.staleAccepts ?? 'N/A',
                            },
                            {
                              title: 'W observed (ms)',
                              render: (_, r: Result['repetitions'][number]) =>
                                r.summary?.observedWindowMs ??
                                'Không quan sát thấy',
                            },
                            {
                              title: 'Censoring',
                              render: (_, r: Result['repetitions'][number]) =>
                                r.summary?.rightCensored
                                  ? 'Observation incomplete'
                                  : 'Theo horizon',
                            },
                          ]}
                        />
                        <Title level={4}>Xuất dữ liệu bất biến</Title>
                        <Space wrap>
                          {[
                            'json',
                            'samples.csv',
                            'events.csv',
                            'summary.csv',
                            'pdf',
                            'png',
                            'md',
                            'svg',
                          ].map((format) => (
                            <Button
                              key={format}
                              icon={<DownloadOutlined aria-hidden />}
                              href={`/api/research/runs/${selected}/export?format=${format}`}
                            >
                              {format}
                            </Button>
                          ))}
                          <Button onClick={() => window.print()}>
                            In / lưu PDF
                          </Button>
                        </Space>
                        <Paragraph style={{ marginTop: 16 }}>
                          Config:{' '}
                          <code>{JSON.stringify(result.run.config)}</code>
                        </Paragraph>
                        <Paragraph>
                          Provenance:{' '}
                          <code>{JSON.stringify(result.run.manifest)}</code>
                        </Paragraph>
                      </>
                    )}
                  </Card>
                </>
              )}
            </>
          )}
        </Layout.Content>
        <Layout.Footer>
          EmuKey Research Lab · Local-only research variant · Bằng chứng có giới
          hạn, kết quả có thể tái kiểm tra.
        </Layout.Footer>
      </Layout>
    </Layout>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#1e40af',
          fontFamily: 'IBM Plex Sans Variable, sans-serif',
          borderRadius: 8,
          colorBgLayout: '#f5f7fb',
        },
      }}
    >
      <AntApp>
        <Lab />
      </AntApp>
    </ConfigProvider>
  </QueryClientProvider>,
);
