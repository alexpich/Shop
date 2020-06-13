import styled from "styled-components";

const PriceTag = styled.span`
  margin: 0 1rem;
  padding: 0 1rem;
  color: ${(props) => props.theme.darkGrey};
  font-size: 1.4rem;
  text-align: left;
`;

export default PriceTag;
