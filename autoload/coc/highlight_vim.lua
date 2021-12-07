coc_highlight_prop_offset = vim.eval('s:prop_offset')

function coc_api_buf_clear_namespace(bufnr, src_id, first, last)
  -- convert 0-indexed to 1-indexed for Vim lnum
  first = first + 1
  last = last + 1
  if src_id == -1 then
    vim.fn.prop_clear(first, last, vim.dict({bufnr = bufnr}))
  else
    vim.fn.prop_remove(vim.dict({
      bufnr = bufnr,
      all = 1,
      id = coc_highlight_prop_offset + src_id,
    }), first, last)
  end
end

function coc_highlight_prop_get_all(bufnr, id, first, last)
  local current = {}

  for line = first + 1, last do
    local items = {}
    local props = vim.fn.prop_list(
      line, vim.dict({bufnr = bufnr, id = id}))

    -- append properties
    for i = 1, #props do
      local prop = props[i]
      local colStart = prop['col'] - 1
      local colEnd = prop['col'] - 1 + prop['length']
      if prop['end'] == 0 then
        colEnd = colEnd - 1
      end

      table.insert(items, vim.dict({
        hlGroup = coc_highlight_prop_type_hlgroup(prop['type']),
        lnum = line - 1,
        colStart = colStart,
        colEnd = colEnd,
      }))
    end

    current[tostring(line - 1)] = vim.list(items)
  end

  return vim.dict(current)
end

function coc_helper_get_character(line, col)
  return vim.fn.strchars(vim.fn.strpart(line, 0, col - 1))
end

function coc_highlight_get_all_highlights(bufnr, ns, lines)
  local highlights = {}
  for line = 1, #lines do
    local props = vim.fn.prop_list(line,
      vim.dict({bufnr = bufnr, id = coc_highlight_prop_offset + ns}))
    for i in 1, ##props do
      local prop = props[i]
      if prop['start'] == 0 or prop['end'] == 0 then
        -- multi line tokens are not supported; ignore it
      else
        local text = lines[line]
        table.insert(highlights, vim.dict({
          hlGroup = coc_highlight_prop_type_hlgroup(prop['type']),
          lnum = line - 1,
          colStart = coc_helper_get_character(text, prop['col']),
          colEnd = coc_helper_get_character(text, prop['col'] + prop['length'])
        }))
      end
    end
  end
  return vim.list(highlights)
end

function coc_highlight_prop_type_hlgroup(type)
  if string.sub(type, 1, 12) == 'CocHighlight' then
    return string.sub(type, 13)
  end
  return vim.fn.prop_type_get(type)['highlight']
end

function coc_highlight_update_all(bufnr, key, ns, new_highlights, first, last)
  local obj_equal = function(a, b)
    for k, v in a() do
      if v ~= b[k] then
        return false
      end
    end
    return true
  end
  local max = math.max

  -- The indices of highlights already existing on this buffer at the correct
  -- position. The listed highlights does not need to be updated.
  local existing_highlight_indices = {}

  local curr_index = 1
  local total = #new_highlights

  local curr_highlights = (vim.funcref('coc#highlight#get'))(bufnr, key, first, last)
  local highlighted_lines = {}
  for k, _ in curr_highlights() do
    table.insert(highlighted_lines, tonumber(k))
  end
  table.sort(highlighted_lines)

  for i = 1, #highlighted_lines do
    local line = highlighted_lines[i]
    local curr_highlights_on_line = curr_highlights[tostring(line)]
    local existing_indices_on_line = {}
    local next_index = curr_index
    if curr_index <= total then
      for j = 1, #curr_highlights_on_line do
        local curr_highlight = curr_highlights_on_line[j]
        for k = curr_index, total do
          local new_highlight = new_highlights[k]
          if new_highlight['lnum'] > curr_highlight['lnum'] then
            next_index = k
            break
          end

          if obj_equal(curr_highlight, new_highlight) then
            table.insert(existing_indices_on_line, k)
            next_index = max(next_index, k+1)
          end
        end
      end
    end

    curr_index = next_index

    if #existing_indices_on_line == #curr_highlights_on_line then
      -- If all highlights of current line still exists, don't clear current
      -- highlight.
      for j = 1, #existing_indices_on_line do
        existing_highlight_indices[existing_indices_on_line[j]] = true
      end
    else
      -- Otherwise, clear this line.
      coc_api_buf_clear_namespace(bufnr, ns, line, line + 1)
    end
  end

  local coc_highlight_add_highlight = vim.funcref('coc#highlight#add_highlight')
  for i = 1, total do
    if not existing_highlight_indices[i] then
      local highlight = new_highlights[i]
      coc_highlight_add_highlight(bufnr, ns,
        highlight['hlGroup'], highlight['lnum'],
        highlight['colStart'], highlight['colEnd'])
    end
  end
end
