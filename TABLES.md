# U3+L3 表格说明

## 基础配置表

| 表格                         | 说明           |
| ---------------------------- | -------------- |
| app_id_mapping               | appid 映射表   |
| auth_code                    | 验证码表       |
| arraign_account              | 提审账户表     |
| message_template             | 消息模板表     |
| application_config           | 基础配置表     |
| application_user_info_config | 用户KYC表      |
| web_link_config              | web 链接配置表 |
| banner_config                | banner 配置表  |
| web_page_content             | web 内容配置表 |
| point_config                 | 埋点配置表     |
| event_define                 | 风控事件表     |
| event_property_config        | 风控配置表     |
| property_define              | 风控配置定义表 |
| loan_product                 | 产品信息表     |
| loan_repay_base_info         | 产品还款信息表 |
| loan_repay_calculate_info    | 产品还款计算表 |
| station_message_setting      | 站点信息配置表 |
| group_config                 | 分组配置表     |

## 数据表

```
预授信相关表：user_credit_amount_limit，user_credit_info,user_credit_product
```

| 表格                     | 说明                 |
| ------------------------ | -------------------- |
| user_loan_summary        | 用户借据表           |
| user_loan_summary_ext    | 用户借据扩展表       |
| user_loan                | 用户借据分期表       |
| user_loan_ext            | 用户借据分期扩展表   |
| user_cash_flow           | 用户现金流表         |
| repay_record             | 用户还款记录流表     |
| exceptional_repay        | 用户异常还款记录流表 |
| user_loan_daily_penalty  | 用户每日罚息表       |
| user_loan_summary_extend | 用户借据展期表       |
| user_loan_extend         | 用户展期分期表       |
| user_loan_daily_interest | 用户每日利息表       |
| customer                 | 用户基础信息表       |
| app_user                 | 用户详细信息表       |
| user_credit_amount_limit | 用户授信额度表       |
| user_desired_product     | 用户意向产品表       |
| user_group               | 用户分组数据表       |
| user_credit_info         | 用户预授信信息表     |
| user_credit_product      | 用户预授信产品表     |

## 网关信息表

```
标准APP的信息表，包括tbl_gw_external_plugin_jar，tbl_gw_base_path_config,tbl_gw_route
```

| 表格                                                            | 说明                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| tbl_gw_base_path_config                                         | bast path 对应配置                                        |
| tbl_gw_base_path_info                                           | bast path 基本信息表                                      |
| tbl_gw_config                                                   | 全局配置                                                  |
| tbl_gw_external_plugin_jar                                      | 外部插件 jar表                                            |
| tbl_gw_flexible_around_route_external_gateway_plugin_management | 灵活 AroundRootExternalGatewayPluginManagement 插件配置表 |
| tbl_gw_proto_info                                               | proto 信息表                                              |
| tbl_gw_proto_source                                             | proto buf 相关配置, the gateway proto source table        |
| tbl_gw_route                                                    | 路由配置表                                                |
