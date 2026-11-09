package harness

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
)

type property struct {
	key     string
	value   any
	index   uint64
	numeric bool
}
type orderedObject struct{ values []property }

func numericKey(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	value, err := strconv.ParseUint(key, 10, 32)
	return value, err == nil && value < 4294967295 && strconv.FormatUint(value, 10) == key
}
func decodeValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 256 {
		return nil, errors.New("JSON nesting limit exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token := token.(type) {
	case json.Delim:
		if token == '{' {
			result := orderedObject{}
			positions := map[string]int{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("invalid JSON key")
				}
				value, err := decodeValue(decoder, depth+1)
				if err != nil {
					return nil, err
				}
				if i, exists := positions[key]; exists {
					result.values[i].value = value
				} else {
					index, numeric := numericKey(key)
					positions[key] = len(result.values)
					result.values = append(result.values, property{key, value, index, numeric})
				}
			}
			if _, err = decoder.Token(); err != nil {
				return nil, err
			}
			sort.SliceStable(result.values, func(i, j int) bool {
				a, b := result.values[i], result.values[j]
				if a.numeric && b.numeric {
					return a.index < b.index
				}
				return a.numeric && !b.numeric
			})
			return result, nil
		}
		if token == '[' {
			values := []any{}
			for decoder.More() {
				value, err := decodeValue(decoder, depth+1)
				if err != nil {
					return nil, err
				}
				values = append(values, value)
			}
			if _, err = decoder.Token(); err != nil {
				return nil, err
			}
			return values, nil
		}
		return nil, errors.New("invalid JSON value")
	case json.Number:
		number, err := strconv.ParseFloat(string(token), 64)
		if err != nil && !math.IsInf(number, 0) {
			return nil, err
		}
		return number, nil
	default:
		return token, nil
	}
}
func jsQuote(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteString(strconv.FormatUint(uint64(r>>4), 16))
				out.WriteString(strconv.FormatUint(uint64(r&15), 16))
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}
func jsNumber(value float64) string {
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	number := strconv.FormatFloat(value, 'e', -1, 64)
	parts := strings.SplitN(number, "e", 2)
	exponent, err := strconv.Atoi(parts[1])
	if err != nil {
		return "null"
	}
	if exponent >= 0 {
		return parts[0] + "e+" + strconv.Itoa(exponent)
	}
	return parts[0] + "e" + strconv.Itoa(exponent)
}
func stringify(out *strings.Builder, value any, depth int, pretty bool) {
	indent := func(n int) {
		if pretty {
			out.WriteByte('\n')
			out.WriteString(strings.Repeat("  ", n))
		}
	}
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if v {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case string:
		out.WriteString(jsQuote(v))
	case float64:
		out.WriteString(jsNumber(v))
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			indent(depth + 1)
			stringify(out, item, depth+1, pretty)
		}
		if len(v) > 0 {
			indent(depth)
		}
		out.WriteByte(']')
	case orderedObject:
		out.WriteByte('{')
		for i, p := range v.values {
			if i > 0 {
				out.WriteByte(',')
			}
			indent(depth + 1)
			out.WriteString(jsQuote(p.key))
			out.WriteByte(':')
			if pretty {
				out.WriteByte(' ')
			}
			stringify(out, p.value, depth+1, pretty)
		}
		if len(v.values) > 0 {
			indent(depth)
		}
		out.WriteByte('}')
	default:
		out.WriteString("null")
	}
}
func jsJSON(raw json.RawMessage, pretty bool) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeValue(decoder, 0)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	stringify(&out, value, 0, pretty)
	return out.String(), nil
}
