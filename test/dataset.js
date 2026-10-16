/**
 * dataset.js — 检索器评测数据集（正例 + 负例）
 * 供 eval-retrieval.js 与 tune.js 共用。
 */
module.exports = {
  /** 口语化变体：模拟真实用户输入，比知识库标准问法更难 */
  COLLOQUIAL: [
    ['我想把买的东西退了', 'faq_refund_001'],
    ['钱啥时候能退回来', 'faq_refund_002'],
    ['退不了款是怎么回事', 'faq_refund_003'],
    ['东西还没发出来', 'faq_order_002'],
    ['地址填错了能改不', 'faq_order_003'],
    ['软件一打开就崩', 'faq_tech_001'],
    ['短信验证码一直没来', 'faq_tech_004'],
    ['付款老是报错', 'faq_tech_005'],
    ['快递卡住不动了', 'faq_logi_002'],
    ['拆开少了个东西', 'faq_logi_003'],
    ['券用不上咋回事', 'faq_acct_002'],
    ['怎么把号注销掉', 'faq_acct_001'],
    ['给我接个人工', 'faq_other_001'],
    ['这个能退款吗', 'faq_refund_001'],
    ['退款失败了', 'faq_refund_003'],
  ],

  /** 无关问题：期望全部低于命中阈值 */
  NEGATIVE: [
    '今天天气怎么样', '帮我写一首诗', '你们老板是谁', 'asdfghjkl',
    '推荐个电影', '股票怎么买', '怎么做红烧肉', '北京到上海多远',
    '量子力学是什么', '明天放假吗', '帮我订个外卖', 'python怎么学',
    '讲个笑话', '世界杯谁赢了',
  ],

  /** 由知识库自身生成标准问法正例：每条的 q + aliases 都应召回自己 */
  buildStandard(FAQ) {
    const out = [];
    FAQ.all().forEach((it) => {
      [it.q, ...(it.aliases || [])].forEach((q) => out.push([q, it.id]));
    });
    return out;
  },
};
