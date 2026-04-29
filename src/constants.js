const FIELDS = ['tvg_id', 'tvg_name', 'tvg_logo', 'group_title', 'display_name', 'url'];
const OPERATORS = ['contains', 'equals', 'starts_with', 'regex'];
const ACTIONS = ['include', 'exclude'];
const COMBINATORS = ['AND', 'OR'];
const CASE_MODES = ['none', 'upper', 'lower', 'capital'];

const FIELDS_SET = new Set(FIELDS);
const OPERATORS_SET = new Set(OPERATORS);
const ACTIONS_SET = new Set(ACTIONS);
const COMBINATORS_SET = new Set(COMBINATORS);
const CASE_MODES_SET = new Set(CASE_MODES);

module.exports = {
  FIELDS, OPERATORS, ACTIONS, COMBINATORS, CASE_MODES,
  FIELDS_SET, OPERATORS_SET, ACTIONS_SET, COMBINATORS_SET, CASE_MODES_SET,
};
