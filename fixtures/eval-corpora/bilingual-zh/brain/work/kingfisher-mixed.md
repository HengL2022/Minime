---
title: Kingfisher 项目笔记
---

# Kingfisher 项目笔记

Kingfisher 是我们新一代的 cross-border payment rail，目标 launch 日期是 2026年9月15日。

技术指标：p95 latency 要低于 800ms（现在是 1.3s），结算从 T+1 改成当天。对接的 partner banks：新加坡这边是 DBS，中国那边是招商银行（CMB），香港走 license partner。

最大的风险是 MAS 的合规审批，submission 在 2026年5月30日交了，正常要等 12 周。Compliance 团队的 contact 是 Priya Nair。外包的 integration 工作给了 Thoughtworks，他们的 tech lead 叫 Marcus，每周五 sync。

FX pricing 引擎用内部的 Quote Service v3，spread 配置在 admin console 里，千万不要手改 production 的 YAML——2026年2月那次 incident 就是这么来的，回滚花了四个小时。
